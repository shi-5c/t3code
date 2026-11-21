import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

export async function openNativePeer(WebSocket, { url, bearer, name, timeout = 30_000 }) {
  const address = new URL(url);
  if (
    address.protocol !== "ws:" ||
    address.hostname !== "127.0.0.1" ||
    !address.port ||
    address.username ||
    address.password ||
    !bearer
  ) {
    throw new Error("A protected local app-server endpoint is required.");
  }

  const socket = new WebSocket(address, {
    headers: { Authorization: `Bearer ${bearer}` },
    followRedirects: false,
    handshakeTimeout: timeout,
    maxPayload: 32 * 1024 * 1024,
    perMessageDeflate: false,
  });
  return openRpcPeer(
    {
      ready: new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
        socket.once("close", () => reject(new Error("The app-server connection did not open.")));
      }),
      onClose(listener) {
        socket.on("close", listener);
        socket.on("error", listener);
      },
      onMessage(listener) {
        socket.on("message", (data, binary) => {
          if (binary) socket.terminate();
          else listener(data.toString());
        });
      },
      send(text) {
        socket.send(text);
      },
      close() {
        socket.terminate();
      },
    },
    { name, timeout },
  );
}

export function openForwarderPeer(connector, options) {
  const child = NodeChildProcess.spawn(connector, ["--t3-desktop-share-connect"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  return openRpcPeer(
    {
      ready: new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }),
      onClose(listener) {
        child.on("close", listener);
        child.on("error", listener);
        child.stdin.on("error", listener);
      },
      onMessage(listener) {
        lines.on("line", listener);
      },
      send(text) {
        child.stdin.write(text + "\n");
      },
      close() {
        child.stdin.end();
        lines.close();
        child.kill();
      },
    },
    options,
  );
}

export async function openRpcPeer(wire, { name, timeout = 30_000 }) {
  const pending = new Map();
  const approvals = new Set();
  const notifications = new Set();
  const requests = new Set();
  const onClose = new Set();
  let nextId = 0;
  let closed = false;

  function finish() {
    if (closed) return;
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("The app-server connection was lost before the request was acknowledged."));
    }
    pending.clear();
    approvals.clear();
    for (const listener of onClose) listener();
  }

  function send(message) {
    if (closed) {
      throw new Error("The app-server connection is offline.");
    }
    wire.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`The app-server did not acknowledge ${method}.`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      try {
        send({ id, method, params });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  wire.onClose(finish);
  wire.onMessage((data) => {
    if (closed) return;
    let message;
    try {
      message = JSON.parse(data);
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw new Error("Unexpected app-server frame.");
      }
    } catch {
      wire.close();
      return;
    }

    if (message.method && message.id != null) {
      approvals.add(message.id);
      for (const listener of requests) listener(message);
    } else if (message.method) {
      if (message.method === "serverRequest/resolved") {
        approvals.delete(message.params?.requestId);
      }
      for (const listener of notifications) listener(message);
    } else {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(
          Object.assign(new Error("Native app-server rejected the request."), {
            code: message.error.code,
          }),
        );
      } else {
        waiter.resolve(message.result);
      }
    }
  });

  try {
    await wire.ready;
    await request("initialize", {
      clientInfo: { name, version: "1.0.0" },
      capabilities: { experimentalApi: true, requiredHumanApproval: true },
    });
    send({ method: "initialized" });
  } catch (error) {
    wire.close();
    throw error;
  }

  return {
    request,
    respond(id, result) {
      if (!approvals.delete(id)) throw new Error("The native request is no longer pending.");
      send({ id, result });
    },
    onNotification(listener) {
      notifications.add(listener);
      return () => notifications.delete(listener);
    },
    onRequest(listener) {
      requests.add(listener);
      return () => requests.delete(listener);
    },
    onClose(listener) {
      if (closed) listener();
      else onClose.add(listener);
      return () => onClose.delete(listener);
    },
    close() {
      finish();
      wire.close();
    },
  };
}
