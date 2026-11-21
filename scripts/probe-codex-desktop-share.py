"""Check control-socket framing and bearer admission with the Windows Codex CLI.

Run with Python 3, websocket-client, and the absolute path to the CLI executable.
The probe creates its own isolated Codex home and never starts Codex Desktop.
"""

import argparse
import base64
import contextlib
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import threading
import time

import websocket


ISSUER = "t3-isolated-share-probe"


def spawn(stack, binary, home, args, *, proxy=False):
    env = {
        name: os.environ[name]
        for name in ("SystemRoot", "WINDIR", "PATH")
        if name in os.environ
    }
    profile_variables = ("CODEX_HOME", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "TEMP", "TMP")
    env.update(dict.fromkeys(profile_variables, str(home)))
    child = subprocess.Popen(
        [str(binary), "app-server", *args],
        cwd=home,
        env=env,
        stdin=subprocess.PIPE if proxy else subprocess.DEVNULL,
        stdout=subprocess.PIPE if proxy else subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )

    def close():
        if child.poll() is None:
            child.terminate()
        child.wait(timeout=5)
        for stream in (child.stdin, child.stdout):
            if stream is not None:
                stream.close()

    stack.callback(close)
    return child


def wait_ready(process, ready):
    deadline = time.monotonic() + 12
    while not ready():
        if process.poll() is not None:
            raise RuntimeError("Isolated app-server exited before opening its listener.")
        if time.monotonic() >= deadline:
            raise RuntimeError("Timed out waiting for the isolated app-server.")
        time.sleep(0.05)


def private_directory(path):
    path.mkdir()
    system_dir = Path(os.environ["SystemRoot"]) / "System32"
    powershell = system_dir / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    sid = subprocess.check_output(
        [
            str(powershell), "-NoProfile", "-NonInteractive", "-Command",
            "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        ],
        text=True,
        timeout=8,
        creationflags=subprocess.CREATE_NO_WINDOW,
    ).strip()
    subprocess.run(
        [str(system_dir / "icacls.exe"), str(path), "/inheritance:r", "/grant:r", f"*{sid}:(OI)(CI)F"],
        capture_output=True,
        check=True,
        timeout=8,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


def proxy_client(stack, proxy):
    client, relay = socket.socketpair()
    stack.callback(client.close)
    stack.callback(relay.close)

    def read_proxy():
        with contextlib.suppress(OSError, ValueError):
            while chunk := proxy.stdout.read1(65536):
                relay.sendall(chunk)
            relay.shutdown(socket.SHUT_WR)

    def write_proxy():
        with contextlib.suppress(OSError, ValueError):
            while chunk := relay.recv(65536):
                proxy.stdin.write(chunk)
                proxy.stdin.flush()
            proxy.stdin.close()

    threading.Thread(target=read_proxy, daemon=True).start()
    threading.Thread(target=write_proxy, daemon=True).start()
    return client


def websocket_session(stack, url, **kwargs):
    peer = websocket.create_connection(
        url, timeout=5, suppress_origin=True, http_no_proxy=["127.0.0.1"], **kwargs
    )
    stack.callback(peer.close)
    return peer


class Client:
    def __init__(self, connection, name):
        self.connection = connection
        self.next_request_id = 0
        self.request("initialize", {"clientInfo": {"name": name, "version": "1"}})
        self.connection.send(json.dumps({"method": "initialized"}))

    def request(self, method, params):
        self.next_request_id += 1
        self.connection.send(
            json.dumps({"id": self.next_request_id, "method": method, "params": params})
        )
        for _ in range(128):
            response = json.loads(self.connection.recv())
            if response.get("id") == self.next_request_id and "method" not in response:
                if "error" in response:
                    code = response["error"].get("code")
                    raise RuntimeError(f"{method} rejected with code {code}.")
                return response["result"]
        raise RuntimeError(f"No response received for {method}.")


def verify_live_thread(home, author, reader):
    thread = author.request("thread/start", {"cwd": str(home), "ephemeral": True})["thread"]
    thread_id = thread["id"]
    loaded = reader.request("thread/loaded/list", {})["data"]
    if thread_id not in loaded:
        raise RuntimeError("The second connection did not see the first connection's live thread.")
    read = reader.request("thread/read", {"threadId": thread_id})["thread"]
    if read["id"] != thread_id:
        raise RuntimeError("The second connection did not read the same native thread.")


def verify_control_socket(binary, home):
    directory = home / "socket"
    private_directory(directory)
    endpoint = directory / "app.sock"
    with contextlib.ExitStack() as stack:
        server = spawn(stack, binary, home, ["--listen", f"unix://{endpoint}"])
        wait_ready(server, endpoint.exists)
        with contextlib.ExitStack() as raw_stack:
            raw_proxy = spawn(raw_stack, binary, home, ["proxy", "--sock", str(endpoint)], proxy=True)
            transport = proxy_client(raw_stack, raw_proxy)
            transport.sendall(b'{"id":1,"method":"initialize","params":{}}\n\n')
            transport.settimeout(0.5)
            try:
                response = transport.recv(4096)
            except (TimeoutError, ConnectionResetError):
                response = b""
            if response.lstrip().startswith(b"{"):
                raise RuntimeError("Control socket unexpectedly answered a raw JSONL request.")
        peers = []
        for name in ("socket-probe-a", "socket-probe-b"):
            proxy = spawn(stack, binary, home, ["proxy", "--sock", str(endpoint)], proxy=True)
            transport = proxy_client(stack, proxy)
            # The proxy forwards bytes. The WebSocket upgrade and JSON-RPC frames come from the client.
            peer = websocket_session(stack, "ws://127.0.0.1/", socket=transport)
            peers.append(Client(peer, name))
        verify_live_thread(home, *peers)


def sign(key, audience, subject, expiration):
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).rstrip(b"=")

    header = encode({"alg": "HS256", "typ": "JWT"})
    claims = encode({"iss": ISSUER, "aud": audience, "sub": subject, "exp": expiration})
    data = b".".join((header, claims))
    signature = base64.urlsafe_b64encode(hmac.digest(key, data, hashlib.sha256)).rstrip(b"=")
    return b".".join((data, signature)).decode()


def verify_bearers(binary, home):
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = reserved.getsockname()[1]
    secret = secrets.token_hex(32).encode()
    secret_directory = home / "auth"
    private_directory(secret_directory)
    secret_file = secret_directory / "secret"
    secret_file.write_bytes(secret)
    audience = secrets.token_hex(16)
    now = int(time.time())
    first = sign(secret, audience, "signed-probe-a", now + 60)
    second = sign(secret, audience, "signed-probe-b", now + 60)
    invalid = (
        None,
        sign(secrets.token_hex(32).encode(), audience, "wrong-key", now + 60),
        sign(secret, "other-instance", "wrong-audience", now + 60),
        sign(secret, audience, "expired", now - 60),
    )

    def listening():
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return True
        except OSError:
            return False

    with contextlib.ExitStack() as stack:
        process = spawn(stack, binary, home, [
            "--listen", f"ws://127.0.0.1:{port}", "--ws-auth", "signed-bearer-token",
            "--ws-shared-secret-file", str(secret_file), "--ws-issuer", ISSUER, "--ws-audience", audience,
            "--ws-max-clock-skew-seconds", "0",
        ])
        wait_ready(process, listening)

        def dial(credential):
            header = [] if credential is None else [f"Authorization: Bearer {credential}"]
            return websocket_session(stack, f"ws://127.0.0.1:{port}/", header=header)

        valid = (Client(dial(first), "signed-probe-a"), Client(dial(second), "signed-probe-b"))
        for credential in invalid:
            try:
                dial(credential)
            except websocket.WebSocketBadStatusException as error:
                if error.status_code != 401:
                    raise RuntimeError("Invalid bearer produced an unexpected response.") from None
            else:
                raise RuntimeError("The isolated app-server admitted an invalid bearer.")
        # A distinct signed subject is accepted at the listener, with access to the same threads.
        verify_live_thread(home, *valid)
        return len(invalid)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cli", type=Path, help="Absolute path to codex.exe")
    args = parser.parse_args()
    if os.name != "nt" or not args.cli.is_absolute() or not args.cli.is_file():
        parser.error("Run on Windows and provide an absolute path to an existing CLI executable.")
    stage = "controlSocket"
    try:
        with tempfile.TemporaryDirectory(prefix="t3p-") as temp:
            root = Path(temp)
            verify_control_socket(args.cli, root)
            stage = "signedBearer"
            rejected = verify_bearers(args.cli, root)
    except (
        OSError, RuntimeError, subprocess.SubprocessError,
        websocket.WebSocketException, ValueError, KeyError, TypeError,
    ) as error:
        print(json.dumps({"status": "failed", "stage": stage, "errorType": type(error).__name__}))
        return 1

    print(json.dumps({
        "rawJsonlRejected": True,
        "controlSocketWebsocket": True,
        "sameLiveThread": True,
        "separateSignedCredentials": True,
        "rejectedCredentials": rejected,
        "crossSubjectThreadRead": True,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
