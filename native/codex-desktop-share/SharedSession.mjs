import * as NodeTimersPromises from "node:timers/promises";

const historyRefreshNotifications = new Set([
  "turn/completed",
  "thread/compacted",
  "thread/reverted",
]);

function requireId(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing native ${label} ID.`);
  }
  return value;
}

async function readHistory(peer, threadId, historyMode) {
  const turns = new Map();
  const cursors = new Set();
  function record(page) {
    for (const turn of page) {
      const id = requireId(turn.id, "turn");
      const items = new Map();
      for (const item of turn.items) {
        items.set(requireId(item.id, "item"), item);
      }
      turns.set(id, { ...turn, items: [...items.values()] });
    }
  }
  if (historyMode === "legacy") {
    const { thread } = await peer.request("thread/read", { threadId, includeTurns: true });
    if (thread.id !== threadId)
      throw new Error("The app-server returned a different native thread.");
    record(thread.turns);
    return [...turns.values()];
  }
  let cursor = null;
  do {
    const page = await peer.request("thread/turns/list", {
      threadId,
      cursor,
      limit: 50,
      sortDirection: "asc",
      itemsView: "full",
    });
    record(page.data);
    cursor = page.nextCursor;
    if (cursor != null && (typeof cursor !== "string" || cursors.has(cursor))) {
      throw new Error("Invalid or repeated native history cursor.");
    }
    cursors.add(cursor);
  } while (cursor != null);
  return [...turns.values()];
}

export class SharedSession {
  #threadId;
  #openPeer;
  #peer;
  #connecting;
  #refreshing;
  #repairing;
  #retryWait;
  #shutdown = new AbortController();
  #closed = false;
  #online = false;
  #turns = [];
  #revision = 0;
  #historyMode;
  #listeners = new Set();
  #notifications = new Set();
  #requests = new Set();

  constructor(threadId, openPeer, retryWait = NodeTimersPromises.setTimeout) {
    this.#threadId = requireId(threadId, "thread");
    this.#openPeer = openPeer;
    this.#retryWait = retryWait;
  }

  get snapshot() {
    return { threadId: this.#threadId, online: this.#online, turns: this.#turns };
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onNotification(listener) {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  onRequest(listener) {
    this.#requests.add(listener);
    return () => this.#requests.delete(listener);
  }

  #publish() {
    for (const listener of this.#listeners) listener(this.snapshot);
  }

  #disconnect(peer) {
    if (this.#peer !== peer) return;
    const wasOnline = this.#online;
    this.#peer = undefined;
    this.#online = false;
    this.#publish();
    if (wasOnline && !this.#closed && !this.#repairing) {
      this.#repairing = this.#repair().finally(() => {
        this.#repairing = undefined;
      });
    }
  }

  async #repair() {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await this.#retryWait(Math.min(250 * 2 ** attempt, 4000), undefined, {
          signal: this.#shutdown.signal,
          ref: false,
        });
      } catch {
        return;
      }
      if (this.#closed || this.#online) return;
      try {
        await this.connect();
        return;
      } catch {
        // The next attempt opens a new connection and never replays a mutation.
      }
    }
  }

  connect() {
    if (this.#closed) return Promise.reject(new Error("The shared session is closed."));
    if (this.#online) return Promise.resolve();
    this.#connecting ??= this.#attach().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #attach() {
    const peer = await this.#openPeer();
    try {
      if (this.#closed) throw new Error("The shared session is closed.");
      this.#peer = peer;
      peer.onClose(() => this.#disconnect(peer));
      peer.onNotification((message) => {
        const { method, params } = message;
        if (this.#peer !== peer || params?.threadId !== this.#threadId) return;
        for (const listener of this.#notifications) listener(message);
        if (!historyRefreshNotifications.has(method)) return;
        this.#revision++;
        if (this.#online) {
          void this.refresh().catch(() => {
            this.#disconnect(peer);
            peer.close();
          });
        }
      });
      peer.onRequest((request) => {
        if (this.#peer !== peer || request.params?.threadId !== this.#threadId) return;
        const respond = (result) => {
          if (this.#peer !== peer) {
            throw new Error("The approval belongs to a closed connection.");
          }
          peer.respond(request.id, result);
        };
        for (const listener of this.#requests) listener({ ...request, respond });
      });
      const response = await peer.request("thread/resume", { threadId: this.#threadId });
      if (response.thread.id !== this.#threadId) {
        throw new Error("The app-server resumed a different native thread.");
      }
      this.#historyMode = response.thread.historyMode;
      await this.#refreshHistory(peer);
      if (this.#peer !== peer)
        throw new Error("Disconnected before the native history was received.");
      this.#online = true;
      this.#publish();
    } catch (error) {
      this.#disconnect(peer);
      peer.close();
      throw error;
    }
  }

  refresh() {
    const peer = this.#requireOnline();
    if (this.#refreshing?.peer === peer) return this.#refreshing.result;
    const result = this.#refreshHistory(peer).finally(() => {
      if (this.#refreshing?.peer === peer) this.#refreshing = undefined;
    });
    this.#refreshing = { peer, result };
    return result;
  }

  async #refreshHistory(peer) {
    const historyMode = this.#historyMode;
    let revision;
    do {
      revision = this.#revision;
      const turns = await readHistory(peer, this.#threadId, historyMode);
      if (this.#peer !== peer) return;
      if (revision === this.#revision) {
        this.#turns = turns;
        if (this.#online) this.#publish();
      }
    } while (revision !== this.#revision);
  }

  #requireOnline() {
    if (!this.#online || !this.#peer) throw new Error("The native session is offline.");
    return this.#peer;
  }

  async startTurn(text) {
    // A dropped response can follow a successful write. Reconnecting only reads history.
    return this.#requireOnline().request("turn/start", {
      threadId: this.#threadId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  close() {
    this.#closed = true;
    this.#shutdown.abort();
    const peer = this.#peer;
    if (peer) {
      this.#disconnect(peer);
      peer.close();
    }
    this.#listeners.clear();
    this.#notifications.clear();
    this.#requests.clear();
  }
}
