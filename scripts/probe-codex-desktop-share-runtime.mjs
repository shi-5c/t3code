import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { openForwarderPeer, openNativePeer } from "../native/codex-desktop-share/NativePeer.mjs";
import { SharedSession } from "../native/codex-desktop-share/SharedSession.mjs";

function within(timeout, promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out at ${label}.`)), timeout);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

function awaitMessage(subscribe, predicate, label) {
  let unsubscribe;
  const result = within(
    45_000,
    new Promise((resolve) => {
      unsubscribe = subscribe((message) => {
        if (predicate(message)) resolve(message);
      });
    }),
    label,
  ).finally(() => unsubscribe?.());
  void result.catch(() => {});
  return result;
}

async function exists(path) {
  try {
    await NodeFSP.access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function credential(secret, audience, subject) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: "t3-native-share-fixture",
    aud: audience,
    sub: subject,
    exp: Math.floor(Date.now() / 1000) + 420,
  })}`;
  return `${data}.${NodeCrypto.createHmac("sha256", secret).update(data).digest("base64url")}`;
}

function localModel(command) {
  let sequence = 0;
  let requestedApproval = false;
  return NodeHttp.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    try {
      let input = "";
      for await (const chunk of request) input += chunk;
      const payload = JSON.parse(input);
      const responseId = `resp_t3_fixture_${++sequence}`;
      let item;
      if (input.includes("t3-request-approval") && !requestedApproval) {
        const tool = payload.tools.find(
          (entry) => entry.name === "shell_command" || entry.name === "exec_command",
        );
        NodeAssert.ok(tool, "The sandboxed command tool was unavailable.");
        requestedApproval = true;
        item = {
          id: `fc_${sequence}`,
          type: "function_call",
          call_id: `call_${sequence}`,
          name: tool.name,
          arguments: JSON.stringify({
            [tool.name === "exec_command" ? "cmd" : "command"]: command,
            sandbox_permissions: "require_escalated",
            justification: "Run the harmless acceptance-fixture command.",
          }),
          status: "completed",
        };
      } else {
        item = {
          id: `msg_${sequence}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "isolated native reply", annotations: [] }],
        };
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      emit({ type: "response.created", response: { id: responseId, output: [] } });
      emit({ type: "response.output_item.added", output_index: 0, item });
      emit({ type: "response.output_item.done", output_index: 0, item });
      emit({
        type: "response.completed",
        response: { id: responseId, status: "completed", output: [item] },
      });
      response.end();
    } catch {
      response.writeHead(500).end();
    }
  });
}

async function probeIsolated(binary, websocketModule) {
  NodeAssert.ok(
    binary &&
      NodePath.isAbsolute(binary) &&
      websocketModule &&
      NodePath.isAbsolute(websocketModule),
    "Provide absolute paths to the native Codex CLI and the ws module entry.",
  );
  const { default: WebSocket } = await import(NodeURL.pathToFileURL(websocketModule).href);
  const tempRoot = await NodeFSP.realpath(NodeOS.tmpdir());
  const root = await NodeFSP.mkdtemp(NodePath.join(tempRoot, "t3-share-runtime-"));
  NodeAssert.equal(NodePath.dirname(root), tempRoot);
  const work = NodePath.join(root, "workspace");
  const isolated = NodePath.join(root, "profile");
  const approvalTarget = NodePath.join(work, "approval-marker.txt");
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const setContent = (path) => `Set-Content -LiteralPath ${quote(path)} -Value t3-fixture`;
  const model = localModel(setContent(approvalTarget));
  const resources = [];
  const proof = {};
  let phase = "fixture";
  let child;
  try {
    await Promise.all([NodeFSP.mkdir(work), NodeFSP.mkdir(isolated)]);
    model.listen(0, "127.0.0.1");
    await NodeEvents.once(model, "listening");
    const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;
    await NodeFSP.writeFile(
      NodePath.join(isolated, "config.toml"),
      [
        'model = "t3-fixture"',
        'model_provider = "t3_fixture"',
        'approval_policy = "on-request"',
        'approvals_reviewer = "user"',
        'sandbox_mode = "workspace-write"',
        "[windows]",
        'sandbox = "unelevated"',
        "[model_providers.t3_fixture]",
        'name = "Local acceptance fixture"',
        `base_url = "${modelUrl}"`,
        'wire_api = "responses"',
      ].join("\n"),
    );

    phase = "authenticated listener";
    const secret = NodeCrypto.randomBytes(32).toString("hex");
    const secretPath = NodePath.join(isolated, "native-listener-secret");
    await NodeFSP.writeFile(secretPath, secret, { flag: "wx", mode: 0o600 });
    const audience = NodeCrypto.randomBytes(16).toString("hex");
    const envNames = new Set([
      "SYSTEMROOT",
      "WINDIR",
      "PATH",
      "COMSPEC",
      "SYSTEMDRIVE",
      "PROGRAMDATA",
    ]);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => envNames.has(name.toUpperCase())),
    );
    for (const name of ["CODEX_HOME", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "TEMP", "TMP"]) {
      env[name] = isolated;
    }
    child = NodeChildProcess.spawn(
      binary,
      [
        "app-server",
        "--listen",
        "ws://127.0.0.1:0",
        "--ws-auth",
        "signed-bearer-token",
        "--ws-shared-secret-file",
        secretPath,
        "--ws-issuer",
        "t3-native-share-fixture",
        "--ws-audience",
        audience,
      ],
      { env, cwd: work, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    const url = await within(
      20_000,
      new Promise((resolve, reject) => {
        let tail = "";
        child.once("error", reject);
        child.once("exit", () => reject(new Error("The native fixture server exited.")));
        child.stderr.setEncoding("utf8").on("data", (chunk) => {
          tail = (tail + chunk).slice(-4096);
          const match = /listening on: (ws:\/\/127\.0\.0\.1:\d+)/.exec(tail);
          if (match) resolve(match[1]);
        });
      }),
      "native listener",
    );
    const connectPeer = async (name) => {
      const peer = await openNativePeer(WebSocket, {
        url,
        bearer: credential(secret, audience, name),
        name,
      });
      resources.push(peer);
      return peer;
    };
    const author = await connectPeer("fixture-native-author");
    const threadId = (await author.request("thread/start", { cwd: work, ephemeral: false })).thread
      .id;
    async function complete(peer, write) {
      let expectedId;
      const observed = new Map();
      const completion = Promise.withResolvers();
      const unsubscribe = peer.onNotification(({ method, params }) => {
        if (method !== "turn/completed" || params.threadId !== threadId) return;
        const turn = params.turn;
        observed.set(turn.id, turn);
        if (turn.id === expectedId) completion.resolve(turn);
      });
      try {
        expectedId = (await write()).turn.id;
        return (
          observed.get(expectedId) ??
          (await within(45_000, completion.promise, "native turn completion"))
        );
      } finally {
        unsubscribe();
      }
    }
    const send = (peer, text) =>
      peer.request("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
      });
    const originalTurn = await complete(author, () => send(author, "t3-native-history-fixture"));
    NodeAssert.equal(originalTurn.status, "completed");

    phase = "native history and two-way turns";
    let follower;
    const reconnect = Promise.withResolvers();
    const shared = new SharedSession(
      threadId,
      async () => {
        follower = await connectPeer("fixture-t3-follower");
        return follower;
      },
      () => reconnect.promise,
    );
    resources.push(shared);
    try {
      await shared.connect();
      NodeAssert.equal(shared.snapshot.turns[0].id, originalTurn.id);
      NodeAssert.ok(shared.snapshot.turns[0].items.length >= 2);
      proof.nativeHistory = true;
      const fromAuthor = await complete(shared, () => send(author, "t3-message-from-author"));
      NodeAssert.equal(fromAuthor.status, "completed");
      const fromFollower = await complete(author, () =>
        shared.startTurn("t3-message-from-follower"),
      );
      NodeAssert.equal(fromFollower.status, "completed");
      proof.bidirectionalTurns = true;

      phase = "disconnect and history reconciliation";
      follower.close();
      NodeAssert.equal(shared.snapshot.online, false);
      await NodeAssert.rejects(shared.startTurn("t3-must-not-be-sent"));
      const missed = await complete(author, () =>
        send(author, "t3-message-while-follower-offline"),
      );
      const missedId = missed.id;
      const reconnected = awaitMessage(
        (listener) => shared.subscribe(listener),
        (snapshot) => snapshot.online && snapshot.turns.some((turn) => turn.id === missedId),
        "automatic reconnect",
      );
      reconnect.resolve();
      await reconnected;
      const ids = shared.snapshot.turns.map((turn) => turn.id);
      proof.reconnectHistory = {
        turns: ids.length,
        distinctTurns: new Set(ids).size,
        sawAllFour: [originalTurn, fromAuthor, fromFollower, missed].every(({ id }) =>
          ids.includes(id),
        ),
      };
      NodeAssert.equal(ids.length, 4);
      NodeAssert.equal(new Set(ids).size, ids.length);
      NodeAssert.ok(proof.reconnectHistory.sawAllFour);
      phase = "native history pagination";
      const firstPage = await follower.request("thread/turns/list", {
        threadId,
        itemsView: "full",
        sortDirection: "asc",
        limit: 2,
      });
      NodeAssert.equal(firstPage.data.length, 2);
      NodeAssert.ok(firstPage.nextCursor);
      const secondPage = await follower.request("thread/turns/list", {
        threadId,
        itemsView: "full",
        sortDirection: "asc",
        limit: 2,
        cursor: firstPage.nextCursor,
      });
      NodeAssert.deepEqual(
        [...firstPage.data, ...secondPage.data].map((turn) => turn.id),
        ids,
      );
      proof.reconnectedWithoutDuplicates = true;

      phase = "approval";
      const approvalFor = (peer) =>
        awaitMessage(
          (listener) => peer.onRequest(listener),
          ({ method, params }) =>
            method === "item/commandExecution/requestApproval" && params.threadId === threadId,
          "native approval",
        );
      const authorApproval = approvalFor(author);
      const followerApproval = approvalFor(shared);
      const approvalTurn = complete(author, () => send(author, "t3-request-approval"));
      void approvalTurn.catch(() => {});
      const [firstApproval, secondApproval] = await Promise.all([authorApproval, followerApproval]);
      NodeAssert.equal(firstApproval.params.itemId, secondApproval.params.itemId);
      const resolvedFor = (peer, id) =>
        awaitMessage(
          (listener) => peer.onNotification(listener),
          ({ method, params }) => method === "serverRequest/resolved" && params.requestId === id,
          "native approval resolution",
        );
      const resolved = Promise.all([
        resolvedFor(author, firstApproval.id),
        resolvedFor(shared, secondApproval.id),
      ]);
      secondApproval.respond({ decision: "decline" });
      await resolved;
      NodeAssert.throws(() => author.respond(firstApproval.id, { decision: "accept" }));
      NodeAssert.equal((await approvalTurn).status, "completed");
      NodeAssert.equal(await exists(approvalTarget), false);
      proof.singleApprovalDecision = true;

      phase = "Windows sandbox";
      const deniedFile = NodePath.join(work, "read-only-marker.txt");
      const allowedFile = NodePath.join(work, "workspace-marker.txt");
      const powershell = NodePath.join(
        env.SystemRoot ?? env.SYSTEMROOT,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const exec = (peer, path, sandboxPolicy) =>
        peer.request("command/exec", {
          command: [
            powershell,
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$ErrorActionPreference='Stop'; ${setContent(path)}`,
          ],
          cwd: work,
          timeoutMs: 20_000,
          sandboxPolicy,
        });
      const denied = await exec(follower, deniedFile, { type: "readOnly" });
      const allowed = await exec(author, allowedFile, {
        type: "workspaceWrite",
        writableRoots: [work],
      });
      const deniedFileExists = await exists(deniedFile);
      const allowedFileExists = await exists(allowedFile);
      proof.sandboxChecks = {
        readOnlyExitCode: denied.exitCode,
        readOnlyWroteFile: deniedFileExists,
        workspaceExitCode: allowed.exitCode,
        workspaceWroteFile: allowedFileExists,
      };
      NodeAssert.notEqual(denied.exitCode, 0);
      NodeAssert.equal(deniedFileExists, false);
      NodeAssert.equal(allowed.exitCode, 0);
      NodeAssert.equal(allowedFileExists, true);
      proof.windowsSandbox = true;
    } finally {
      shared.close();
    }
    console.log(JSON.stringify({ scope: "isolated-native-app-server", ...proof }));
  } catch (error) {
    console.error(
      JSON.stringify({
        scope: "isolated-native-app-server",
        phase,
        error: error.name,
        code: error.code ?? null,
        ...proof,
      }),
    );
    process.exitCode = 1;
  } finally {
    for (const resource of resources.reverse()) resource.close();
    model.closeAllConnections();
    model.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = NodeEvents.once(child, "exit").catch(() => {});
      child.kill();
      await within(8000, closed, "native server exit").catch(() => {});
    }
    await NodeFSP.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function probeLive(connector, threadId) {
  NodeAssert.ok(
    connector &&
      NodePath.isAbsolute(connector) &&
      /^forward-[a-f0-9]{32}\.exe$/i.test(NodePath.basename(connector)),
  );
  NodeAssert.match(threadId ?? "", /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  const session = new SharedSession(threadId, () =>
    openForwarderPeer(connector, { name: "T3 Code" }),
  );
  try {
    await session.connect();
    const { turns, online } = session.snapshot;
    console.log(JSON.stringify({ scope: "live-desktop-app-server", online, turns: turns.length }));
  } finally {
    session.close();
  }
}

const [binary, argument, threadId] = process.argv.slice(2);
// oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone Windows probe runs without Effect.
NodeAssert.equal(NodeOS.platform(), "win32");
if (argument === "--live") await probeLive(binary, threadId);
else await probeIsolated(binary, argument);
