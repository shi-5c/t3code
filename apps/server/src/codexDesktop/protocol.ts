// @effect-diagnostics nodeBuiltinImport:off globalTimers:off extendsNativeError:off - Node socket callbacks own these resources; the service maps failures into CodexDesktopError.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";

// Desktop IPC is versioned independently of the public app-server protocol.
const DESKTOP_PIPE = "\\\\.\\pipe\\codex-ipc";
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const string = (value: unknown): string => (typeof value === "string" ? value : "");

export class DesktopTransportError extends Error {
  readonly outcomeUnknown: boolean;
  constructor(message: string, outcomeUnknown = false) {
    super(message);
    this.outcomeUnknown = outcomeUnknown;
  }
}

/** Handles split headers, coalesced frames and a bound before allocating the body. */
export class FrameDecoder {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private body: Buffer | undefined;
  private bodyBytes = 0;
  push(chunk: Buffer, receive: (message: Record<string, unknown>) => void) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const size = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + size);
        offset += size;
        this.headerBytes += size;
        if (this.headerBytes < 4) continue;
        const length = this.header.readUInt32LE();
        if (length === 0 || length > MAX_FRAME_BYTES)
          throw new Error("Invalid Desktop frame size.");
        this.body = Buffer.alloc(length);
        this.bodyBytes = 0;
      }
      const size = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
      chunk.copy(this.body, this.bodyBytes, offset, offset + size);
      offset += size;
      this.bodyBytes += size;
      if (this.bodyBytes === this.body.length) {
        const message = record(JSON.parse(this.body.toString("utf8")));
        this.body = undefined;
        this.headerBytes = 0;
        receive(message);
      }
    }
  }
}

export function desktopTextInput(text: string) {
  if (!text.trim() || text.length > 64_000)
    throw new Error("Enter a message of up to 64,000 characters.");
  // Required by the Desktop renderer, even though app-server accepts omission.
  return [{ type: "text", text, text_elements: [] }];
}

export class DesktopIpc extends NodeEvents.EventEmitter {
  private socket: NodeNet.Socket | undefined;
  private clientId = "initializing-client";
  private pending = new Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      mutation: boolean;
    }
  >();
  private closed = false;
  private readonly pipe: string;
  private readonly timeoutMs: number;
  constructor(pipe = DESKTOP_PIPE, timeoutMs = 10_000) {
    super();
    this.pipe = pipe;
    this.timeoutMs = timeoutMs;
  }

  async connect() {
    // Only initialization may retry. A turn mutation is never replayed.
    for (let attempt = 0; attempt < 3; attempt++) {
      this.closed = false;
      const decoder = new FrameDecoder();
      const socket = NodeNet.createConnection(this.pipe);
      this.socket = socket;
      socket.on("data", (chunk: Buffer) => {
        try {
          decoder.push(chunk, (message) => this.receive(message));
        } catch {
          socket.destroy(new Error("Codex Desktop sent an invalid IPC frame."));
        }
      });
      socket.on("error", () => {});
      socket.on("close", () => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(
            new DesktopTransportError("Codex Desktop disconnected.", pending.mutation),
          );
        }
        this.pending.clear();
        this.emit("disconnected");
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error("Desktop connection timed out."));
        }, this.timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          socket.off("error", onError);
        };
        const onError = () => {
          cleanup();
          reject(new Error("Open Codex Desktop on this Windows host to connect."));
        };
        socket.once("error", onError);
        socket.once("connect", () => {
          cleanup();
          resolve();
        });
      });
      try {
        const response = await this.request("initialize", { clientType: "t3code" }, 0);
        const clientId = string(record(response.result).clientId);
        if (!clientId) throw new Error("Unsupported Codex Desktop initialization response.");
        this.clientId = clientId;
        return;
      } catch (error) {
        this.close();
        if (
          !(error instanceof Error) ||
          !error.message.includes("no-handler-for-request") ||
          attempt === 2
        )
          throw error;
        // Wait for the previous connection to close before creating another one.
        if (!socket.closed) await new Promise<void>((resolve) => socket.once("close", resolve));
      }
    }
  }

  protected write(message: Record<string, unknown>) {
    if (!this.socket || this.socket.destroyed || this.closed)
      throw new Error("Codex Desktop is disconnected.");
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_FRAME_BYTES) throw new Error("Desktop request exceeds the frame limit.");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }

  protected receive(message: Record<string, unknown>) {
    if (message.type === "response") {
      const id = string(message.requestId);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.resultType === "success") pending.resolve(message);
      else
        pending.reject(
          new DesktopTransportError(
            `Codex Desktop: ${string(message.error) || "request rejected"}`,
            // Owner errors can occur after submitting to its execution process.
            pending.mutation,
          ),
        );
    } else if (message.type === "client-discovery-request") {
      this.write({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false },
      });
    } else if (message.type === "request") {
      // This is a follower, never an owner or an app-tool handler. An explicit
      // rejection lets the router try a real handler instead of timing out.
      this.write({
        type: "response",
        requestId: message.requestId,
        resultType: "error",
        error: "no-handler-for-request",
      });
    } else if (message.type === "broadcast") {
      if (
        Array.isArray(message.targetClientIds) &&
        !message.targetClientIds.includes(this.clientId)
      )
        return;
      this.emit("broadcast", message);
    }
  }

  request(
    method: string,
    params: Record<string, unknown>,
    version: number,
    targetClientId?: string,
    mutation = false,
  ) {
    const requestId = NodeCrypto.randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new DesktopTransportError(
            "Codex Desktop request timed out. Check the conversation before sending again.",
            mutation,
          ),
        );
      }, this.timeoutMs + 1000);
      this.pending.set(requestId, { resolve, reject, timer, mutation });
      try {
        this.write({
          type: "request",
          requestId,
          sourceClientId: this.clientId,
          version,
          method,
          params,
          targetClientId,
          timeoutMs: this.timeoutMs,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(
          new DesktopTransportError(
            error instanceof Error ? error.message : "Desktop write failed.",
            mutation,
          ),
        );
      }
    });
  }

  follow(conversationId: string, owner: string, following: boolean) {
    this.write({
      type: "broadcast",
      method: "thread-stream-following-changed",
      sourceClientId: this.clientId,
      version: 1,
      params: { conversationId, hostId: "local", following },
      targetClientIds: [owner],
    });
  }

  close() {
    this.closed = true;
    this.socket?.destroy();
  }
}

const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
/** Apply only to a private clone. A bad batch never partially changes the live view. */
export function applyDesktopPatches(state: Record<string, unknown>, patches: unknown) {
  const next = structuredClone(state);
  if (!Array.isArray(patches) || patches.length > 100_000)
    throw new Error("Invalid Desktop patches.");
  for (const raw of patches) {
    const patch = record(raw);
    const path = patch.path;
    if (
      !Array.isArray(path) ||
      !path.length ||
      path.some(
        (key) =>
          (typeof key !== "string" && typeof key !== "number") || forbiddenKeys.has(String(key)),
      )
    ) {
      throw new Error("Invalid Desktop patch path.");
    }
    let target: Record<string, unknown> | unknown[] = next;
    for (const key of path.slice(0, -1)) {
      const child = (target as Record<string, unknown>)[String(key)];
      if (typeof child !== "object" || child === null || !Object.hasOwn(target, key))
        throw new Error("Missing Desktop patch parent.");
      target = child as Record<string, unknown>;
    }
    const key = String(path.at(-1));
    if (!["add", "remove", "replace"].includes(string(patch.op)))
      throw new Error("Invalid Desktop patch operation.");
    if (Array.isArray(target)) {
      const index = key === "-" ? target.length : Number(key);
      const maximum = patch.op === "add" ? target.length : target.length - 1;
      if (!Number.isInteger(index) || index < 0 || index > maximum)
        throw new Error("Invalid Desktop array index.");
      if (patch.op === "add") target.splice(index, 0, patch.value);
      else if (patch.op === "remove") target.splice(index, 1);
      else target[index] = patch.value;
    } else {
      if (patch.op !== "add" && !Object.hasOwn(target, key))
        throw new Error("Missing Desktop patch value.");
      if (patch.op === "remove") delete target[key];
      else
        Object.defineProperty(target, key, {
          value: patch.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
  }
  return next;
}
