// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - This socket lifecycle is imperative and scoped by the owning Effect stream.
import * as NodeCrypto from "node:crypto";
import type { CodexDesktopSend, CodexDesktopState } from "@t3tools/contracts";
import {
  applyDesktopPatches,
  DesktopIpc,
  DesktopTransportError,
  desktopTextInput,
  record,
  string,
} from "./protocol.ts";
import { projectDesktopConversation } from "./projection.ts";
import { ownerTurnRequest } from "./ownerTurnRequest.ts";
import { desktopReplyMethod, type DesktopRequestRef } from "./requests.ts";

/** One owner connection per followed conversation; never resumes an app-server writer. */
export class DesktopMirror {
  private client: DesktopIpc | undefined;
  private owner = "";
  private state: Record<string, unknown> | undefined;
  private closed = false;
  private connecting = false;
  private refreshing = false;
  private mutating = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private health: ReturnType<typeof setInterval> | undefined;
  private attempts = 0;
  private snapshotWaiters = new Set<() => void>();
  private sends = new Map<
    string,
    { text: string; expectedTurnId: string | null; result: Promise<{ clientMessageId: string }> }
  >();
  readonly listeners = new Set<(state: CodexDesktopState) => void>();
  view: CodexDesktopState;

  readonly conversationId: string;
  get canonicalState() {
    return this.state ?? null;
  }
  private readonly makeClient: () => DesktopIpc;
  constructor(conversationId: string, makeClient = () => new DesktopIpc()) {
    this.conversationId = conversationId;
    this.makeClient = makeClient;
    this.view = {
      conversationId,
      status: "connecting",
      detail: "Connecting to Codex Desktop…",
      epoch: NodeCrypto.randomUUID(),
      revision: -1,
      title: "Codex Desktop",
      cwd: "",
      model: "",
      activeTurnId: null,
      pendingRequests: 0,
      messages: [],
      truncated: false,
    };
  }

  private publish(immediate = false) {
    if (this.closed) return;
    if (immediate) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
      for (const listener of this.listeners) listener(this.view);
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = undefined;
        this.publish(true);
      }, 80);
    }
  }

  private unavailable(error: unknown, incompatible = false) {
    if (this.closed || (this.view.status === "incompatible" && !incompatible)) return;
    clearInterval(this.health);
    this.client?.removeAllListeners();
    this.client?.close();
    this.client = undefined;
    this.view = {
      ...this.view,
      status: incompatible ? "incompatible" : "reconnecting",
      detail: error instanceof Error ? error.message : "Codex Desktop is unavailable.",
    };
    this.publish(true);
    if (!incompatible && !this.retry)
      this.retry = setTimeout(
        () => {
          this.retry = undefined;
          void this.connect();
        },
        Math.min(1000 * 2 ** Math.min(this.attempts++, 4), 15_000),
      );
  }

  async connect() {
    if (this.closed || this.connecting) return;
    this.connecting = true;
    const client = this.makeClient();
    this.client = client;
    try {
      await client.connect();
      if (this.closed) {
        client.close();
        return;
      }
      const discovery = await client.request(
        "thread-owner-discovery",
        { hostId: "local", conversationId: this.conversationId },
        1,
      );
      const owner = string(discovery.handledByClientId);
      if (!owner || record(discovery.result).supportsUntrustedAppInput !== true)
        throw new Error("Open this conversation in Codex Desktop to enable shared sending.");
      this.owner = owner;
      this.state = undefined;
      this.view = {
        ...this.view,
        status: "connecting",
        epoch: NodeCrypto.randomUUID(),
        revision: -1,
        detail: "Loading conversation…",
      };
      client.on("disconnected", () =>
        this.unavailable(new Error("Codex Desktop disconnected. Reconnecting…")),
      );
      client.on("broadcast", (message: Record<string, unknown>) => this.receive(message));
      client.follow(this.conversationId, owner, true);
      await this.refresh();
      if (this.closed || this.view.status !== "ready") return;
      // Detect owner migration/unload even when the old Desktop client stays connected.
      this.health = setInterval(() => {
        void client
          .request(
            "thread-owner-discovery",
            { hostId: "local", conversationId: this.conversationId },
            1,
          )
          .then((response) => {
            if (response.handledByClientId !== owner)
              throw new Error("Conversation owner changed. Reconnecting…");
          })
          .catch((error: unknown) => this.unavailable(error));
      }, 15_000);
      this.health.unref();
      this.attempts = 0;
    } catch (error) {
      this.unavailable(error);
    } finally {
      this.connecting = false;
    }
  }

  private async refresh() {
    if (this.refreshing || !this.client) return;
    this.refreshing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onSnapshot: (() => void) | undefined;
    try {
      const snapshot = new Promise<void>((resolve, reject) => {
        onSnapshot = resolve;
        this.snapshotWaiters.add(resolve);
        timer = setTimeout(
          () => reject(new Error("Codex Desktop did not provide a conversation snapshot.")),
          12_000,
        );
      });
      // Attach a rejection handler before waiting for the request acknowledgement.
      snapshot.catch(() => {});
      await this.client.request(
        "thread-follower-load-complete-history",
        { conversationId: this.conversationId },
        1,
        this.owner,
      );
      await snapshot;
    } finally {
      clearTimeout(timer);
      if (onSnapshot) this.snapshotWaiters.delete(onSnapshot);
      this.refreshing = false;
    }
  }

  private receive(message: Record<string, unknown>) {
    const params = record(message.params);
    if (
      message.method !== "thread-stream-state-changed" ||
      message.sourceClientId !== this.owner ||
      params.conversationId !== this.conversationId ||
      params.hostId !== "local"
    )
      return;
    if (message.version !== 11) {
      this.unavailable(
        new Error("This Codex Desktop version needs a bridge update. Sending is disabled."),
        true,
      );
      return;
    }
    const change = record(params.change);
    const revision = change.revision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
      this.unavailable(new Error("Invalid Desktop revision."), true);
      return;
    }
    try {
      if (change.type === "snapshot") {
        if ((revision as number) < this.view.revision)
          this.view = { ...this.view, epoch: NodeCrypto.randomUUID() };
        const state = record(change.conversationState);
        if (state.id !== this.conversationId || (!state.turnHistory && !Array.isArray(state.turns)))
          throw new Error("Unsupported Desktop snapshot.");
        this.state = state;
        for (const resolve of this.snapshotWaiters) resolve();
        // Full snapshots can reset revisions after archive/restore. They establish a new baseline.
      } else if (change.type === "patches") {
        if ((revision as number) <= this.view.revision) return;
        if (!this.state || revision !== this.view.revision + 1) {
          this.state = undefined;
          this.view = {
            ...this.view,
            status: "connecting",
            detail: "Refreshing conversation after a missed update…",
          };
          this.publish(true);
          void this.refresh().catch((error: unknown) => this.unavailable(error));
          return;
        }
        this.state = applyDesktopPatches(this.state, change.patches);
      } else throw new Error("Unsupported Desktop stream update.");
      this.view = {
        ...this.view,
        ...projectDesktopConversation(this.state),
        revision: revision as number,
        status: "ready",
        detail: "Connected to Codex Desktop",
      };
      this.publish();
    } catch {
      this.state = undefined;
      this.view = { ...this.view, status: "connecting", detail: "Refreshing conversation…" };
      this.publish(true);
      void this.refresh().catch((error: unknown) => this.unavailable(error));
    }
  }

  send(input: CodexDesktopSend) {
    const existing = this.sends.get(input.clientMessageId);
    if (existing) {
      if (existing.text !== input.text || existing.expectedTurnId !== input.expectedTurnId)
        return Promise.reject(
          new Error("Message identifier was already used for different input."),
        );
      return existing.result;
    }
    // Keep unresolved outcomes as tombstones. Refuse excess writes instead of evicting dedupe IDs.
    if (this.sends.size >= 1000)
      return Promise.reject(new Error("Reconnect this view before sending more messages."));
    const result = this.sendOnce(input);
    this.sends.set(input.clientMessageId, {
      text: input.text,
      expectedTurnId: input.expectedTurnId,
      result,
    });
    return result;
  }

  private async sendOnce(input: CodexDesktopSend) {
    if (input.expectedTurnId)
      throw new Error(
        "This Desktop protocol cannot atomically target an active turn. Wait for it to finish before sending.",
      );
    await this.start(
      {
        threadId: this.conversationId,
        clientUserMessageId: input.clientMessageId,
        input: desktopTextInput(input.text),
      },
      true,
    );
    return { clientMessageId: input.clientMessageId };
  }

  async start(request: Record<string, unknown>, _inheritThreadSettings = true) {
    const client = this.requireReady(null);
    if (request.threadId !== this.conversationId)
      throw new Error("Turn request does not match the followed conversation.");
    if (this.mutating) throw new Error("Another message is being submitted. Wait for its result.");
    const input = Array.isArray(request.input)
      ? request.input.map((raw) => {
          const part = record(raw);
          return part.type === "text"
            ? {
                ...part,
                text_elements: Array.isArray(part.text_elements) ? part.text_elements : [],
              }
            : part;
        })
      : [];
    this.mutating = true;
    try {
      const response = await client.request(
        "thread-follower-start-turn",
        {
          conversationId: this.conversationId,
          turnStart: {
            request: ownerTurnRequest({ ...request, input }),
            context: {
              inheritThreadSettings: true,
            },
          },
        },
        2,
        this.owner,
        true,
      );
      const nativeTurnId = string(record(record(record(response.result).result).turn).id);
      if (!nativeTurnId)
        throw new DesktopTransportError(
          "The owner acknowledged the message without a recognized turn identifier. Check the conversation before sending again.",
          true,
        );
      return { nativeTurnId };
    } finally {
      this.mutating = false;
    }
  }

  private requireReady(expectedTurnId: string | null, allowPending = false) {
    if (!this.client || this.view.status !== "ready")
      throw new DesktopTransportError("Wait for Codex Desktop to reconnect before sending.");
    if (this.view.activeTurnId !== expectedTurnId)
      throw new Error("The active turn changed. Review the latest conversation and send again.");
    if (this.view.pendingRequests && !allowPending)
      throw new Error("Answer the pending request in Codex Desktop first.");
    return this.client;
  }

  async stop(expectedTurnId: string) {
    const client = this.requireReady(expectedTurnId, true);
    await client.request(
      "thread-follower-interrupt-turn",
      { conversationId: this.conversationId, mode: "user-stop", expectedTurnId },
      4,
      this.owner,
      true,
    );
  }

  async respond(ref: DesktopRequestRef, payload: Record<string, unknown>) {
    if (ref.epoch !== this.view.epoch)
      throw new Error("The Desktop request expired after reconnecting.");
    const requests = Array.isArray(this.state?.requests) ? this.state.requests : [];
    const pending = requests
      .map(record)
      .find(
        (request) =>
          request.id === ref.id &&
          request.method === ref.method &&
          record(request.params).turnId === ref.turnId,
      );
    const method = desktopReplyMethod(ref.method);
    if (!pending || !method)
      throw new Error("The Desktop request is no longer pending or cannot be answered here.");
    const client = this.requireReady(ref.turnId, true);
    await client.request(
      method,
      { conversationId: this.conversationId, requestId: ref.id, ...payload },
      1,
      this.owner,
      true,
    );
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    clearTimeout(this.emitTimer);
    clearInterval(this.health);
    if (this.client) {
      try {
        this.client.follow(this.conversationId, this.owner, false);
      } catch {
        /* Already disconnected. */
      }
      this.client.removeAllListeners();
      this.client.close();
    }
    this.listeners.clear();
    for (const resolve of this.snapshotWaiters) resolve();
    this.snapshotWaiters.clear();
  }
}
