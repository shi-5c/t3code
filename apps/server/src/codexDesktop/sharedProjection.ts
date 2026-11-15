import {
  OrchestrationV2DomainEvent,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { desktopPermissions, desktopTurns } from "./projection.ts";
import { list, record, string } from "./protocol.ts";
import {
  DesktopRequestHistory,
  desktopRequestKind,
  desktopRequestRef,
  desktopReplyMethod,
  desktopResponseKey,
} from "./requests.ts";

const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);

/** Canonical owner choices supersede saved options; model changes discard old-model options. */
export function desktopModelSelection(
  previous: ModelSelection,
  state: Record<string, unknown>,
): ModelSelection {
  const model = string(state.latestModel) || previous.model;
  const inherited = model === previous.model ? previous.options : undefined;
  let options = [...(inherited ?? [])];
  let specified = inherited !== undefined;
  const apply = (id: string, value: unknown, aliases: readonly string[] = []) => {
    // A missing field is a partial snapshot; null explicitly restores the owner default.
    if (value !== null && typeof value !== "string") return;
    specified = true;
    const index = options.findIndex((option) => option.id === id || aliases.includes(option.id));
    options = options.filter((option) => option.id !== id && !aliases.includes(option.id));
    if (typeof value === "string" && value.length > 0)
      options.splice(index < 0 ? options.length : index, 0, { id, value });
  };
  const settings = record(state.latestThreadSettings);
  // Match the owner's next-turn settings; the legacy field may lag or remain null.
  apply(
    "reasoningEffort",
    settings.effort !== undefined ? settings.effort : state.latestReasoningEffort,
  );
  apply("serviceTier", record(state.latestThreadSettings).serviceTier, ["fastMode"]);
  return { instanceId: previous.instanceId, model, ...(specified ? { options } : {}) };
}
const timestamp = (value: unknown, fallback: DateTime.Utc) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? DateTime.makeUnsafe(value)
    : fallback;
const inputText = (value: unknown) =>
  list(value)
    .map((part) => string(record(part).text))
    .filter(Boolean)
    .join("\n");

export interface SharedDesktopTurnContext {
  readonly runId: string;
  readonly attemptId: string;
  readonly nodeId: string;
  readonly providerTurnId: string;
  readonly messageId: string;
  readonly clientMessageId: string;
  readonly userTurnItemId: string;
  readonly ordinal: number;
  readonly providerTurnOrdinal: number;
  readonly startedAtMs: number;
  readonly origin: "t3" | "desktop";
}

/** A partial history updates known turns; it cannot renumber or delete persisted history. */
export class SharedDesktopHistory {
  readonly requests = new DesktopRequestHistory();
  readonly fileItems = new Map<string, Extract<OrchestrationV2TurnItem, { type: "file_change" }>>();
  private ordered: string[] = [];
  private readonly turns = new Map<string, Record<string, unknown>>();
  private initialized = false;
  get ready() {
    return this.initialized;
  }
  merge(state: Record<string, unknown>) {
    const history = record(record(state.turnHistory).history);
    const incoming = [
      ...new Map(
        desktopTurns(state)
          .filter((turn) => string(turn.turnId))
          .map((turn) => [string(turn.turnId), turn]),
      ).values(),
    ];
    if (!this.initialized) {
      if (state.turnHistory !== undefined && history.isComplete !== true) return [];
      this.initialized = true;
    }
    // After a complete baseline, newly discovered turns must follow its known history.
    // An earlier unknown turn contradicts that baseline, so require a fresh import.
    let newSeen = false;
    for (const turn of incoming) {
      const id = string(turn.turnId);
      if (!this.turns.has(id)) newSeen = true;
      else if (newSeen)
        throw new Error(
          "Desktop history changed before the complete baseline. Reimport this conversation.",
        );
    }
    for (const turn of incoming) {
      const id = string(turn.turnId);
      if (!this.turns.has(id)) this.ordered.push(id);
      const previous = this.turns.get(id);
      if (previous) {
        const previousItems = list(previous.items).map(record);
        const nextItems = list(turn.items).map(record);
        const itemKeys = (items: Record<string, unknown>[]) => {
          const firstUser = items.find((item) => item.type === "userMessage");
          return items.map(
            (item, index) =>
              [
                item === firstUser
                  ? "primary-user"
                  : string(item.clientId) || string(item.id) || `${string(item.type)}:${index}`,
                item,
              ] as const,
          );
        };
        const merged = new Map(itemKeys(previousItems));
        for (const [key, item] of itemKeys(nextItems)) merged.set(key, item);
        const primary = merged.get("primary-user");
        const rest = [...merged.entries()]
          .filter(([key]) => key !== "primary-user")
          .map(([, item]) => item);
        const previousParams = record(previous.params);
        const nextParams = { ...previousParams, ...record(turn.params) };
        if (!string(nextParams.model) && string(previousParams.model))
          nextParams.model = previousParams.model;
        this.turns.set(id, {
          ...previous,
          ...turn,
          params: nextParams,
          completedItemIds: {
            ...record(previous.completedItemIds),
            ...record(turn.completedItemIds),
          },
          items: primary ? [primary, ...rest] : rest,
        });
      } else this.turns.set(id, turn);
    }
    return this.ordered.map((id) => this.turns.get(id)!);
  }
}

/** Normalize owner facts into the same records consumed by all existing T3 clients. */
export function sharedDesktopEvents(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly nativeId: string;
  readonly state: Record<string, unknown>;
  readonly epoch: string;
  readonly revision: number;
  readonly now: DateTime.Utc;
  readonly history?: SharedDesktopHistory;
  readonly contexts?: ReadonlyMap<string, SharedDesktopTurnContext>;
  readonly providerThread?: OrchestrationV2ProviderThread;
  readonly syncModelSelection?: boolean;
  readonly requireContexts?: boolean;
  readonly runtimeRequests?: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly knownTurnItems?: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly reservedResponseKeys?: ReadonlySet<string>;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { thread, state, nativeId, now } = input;
  const events: OrchestrationV2DomainEvent[] = [];
  const providerThreadId = input.providerThread?.id ?? `desktop-provider-thread:${nativeId}`;
  const nativeRef = (nativeId: string) => ({ driver: "codex", nativeId, strength: "strong" });
  const emit = (
    type: string,
    payload: { readonly id: string; readonly [key: string]: unknown },
    runId?: string,
    nodeId?: string,
  ) => {
    events.push(
      decodeEvent({
        id: `desktop-event:${input.epoch}:${input.revision}:${type}:${payload.id}`,
        type,
        threadId: thread.id,
        runId,
        nodeId,
        occurredAt: now,
        payload,
      }),
    );
  };
  const modelSelection =
    input.syncModelSelection === false
      ? thread.modelSelection
      : desktopModelSelection(thread.modelSelection, state);
  const history = input.history ?? new SharedDesktopHistory();
  for (const item of input.knownTurnItems ?? [])
    if (item.type === "file_change" && !history.fileItems.has(item.id))
      history.fileItems.set(item.id, item);
  const turns = history.merge(state);
  if (!history.ready) return [];
  const requests = history.requests.update(state, input.epoch, DateTime.toEpochMillis(now));
  const savedRequests = new Map(
    input.runtimeRequests?.map((request) => [String(request.id), request]),
  );
  emit("thread.metadata-updated", {
    ...thread,
    threadType: "codex-shared",
    title: string(state.title) || thread.title,
    modelSelection,
    runtimeMode: desktopPermissions(state).runtimeMode ?? thread.runtimeMode,
    activeProviderThreadId: providerThreadId,
    updatedAt: now,
  });
  const active = turns.some((turn) => turn.status === "inProgress");
  emit("provider-thread.updated", {
    ...input.providerThread,
    nativeMetadata: {
      ...input.providerThread?.nativeMetadata,
      modelSelection: desktopModelSelection(
        input.providerThread?.nativeMetadata?.modelSelection ?? thread.modelSelection,
        state,
      ),
    },
    id: providerThreadId,
    driver: "codex",
    providerInstanceId: thread.providerInstanceId,
    providerSessionId: input.providerThread?.providerSessionId ?? null,
    appThreadId: thread.id,
    ownerNodeId: null,
    nativeThreadRef: nativeRef(nativeId),
    nativeConversationHeadRef: null,
    status: active ? "active" : "idle",
    firstRunOrdinal: turns.length ? 1 : null,
    lastRunOrdinal: turns.length || null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    createdAt: thread.createdAt,
    updatedAt: now,
  });
  let ordinal = 0;
  const baseline = new Set(
    input.providerThread?.nativeMetadata?.codexDesktopHandoff?.baselineTurnIds ?? [],
  );
  for (const [index, turn] of turns.entries()) {
    const nativeTurnId = string(turn.turnId);
    if (baseline.has(nativeTurnId)) continue;
    const context = input.contexts?.get(nativeTurnId);
    if (input.requireContexts && !context) continue;
    const runId = context?.runId ?? `desktop-run:${nativeTurnId}`;
    const attemptId = context?.attemptId ?? `desktop-attempt:${nativeTurnId}`;
    const nodeId = context?.nodeId ?? `desktop-node:${nativeTurnId}`;
    const providerTurnId = context?.providerTurnId ?? `desktop-provider-turn:${nativeTurnId}`;
    const startedAt = timestamp(
      turn.turnStartedAtMs,
      context ? DateTime.makeUnsafe(context.startedAtMs) : thread.createdAt,
    );
    const running = turn.status === "inProgress";
    if (
      !["inProgress", "completed", "interrupted", "failed", "error", "cancelled"].includes(
        string(turn.status),
      )
    )
      throw new Error("Unsupported Desktop turn status. No terminal state was inferred.");
    const status = running
      ? "running"
      : turn.status === "interrupted"
        ? "interrupted"
        : turn.status === "cancelled"
          ? "cancelled"
          : turn.status === "failed" || turn.status === "error" || turn.error
            ? "failed"
            : "completed";
    const completedAt = running
      ? null
      : DateTime.makeUnsafe(
          DateTime.toEpochMillis(startedAt) +
            (typeof turn.durationMs === "number" ? Math.max(0, turn.durationMs) : 0),
        );
    const params = record(turn.params);
    const actualModel =
      string(turn.model) ||
      string(params.model) ||
      string(record(record(params.collaborationMode).settings).model);
    const turnModelSelection = {
      instanceId: thread.modelSelection.instanceId,
      model: actualModel || "unknown",
      ...(string(params.effort)
        ? { options: [{ id: "reasoningEffort", value: string(params.effort) }] }
        : {}),
    };
    const items = list(turn.items).map(record);
    const firstUser = items.find((item) => item.type === "userMessage");
    const userId = `${nativeTurnId}:input`;
    const userMessageId = context?.messageId ?? `desktop-message:${nativeId}:${userId}`;
    const itemBase = (id: string, itemStatus = status) => ({
      id: id === userId && context ? context.userTurnItemId : `desktop-item:${nativeId}:${id}`,
      threadId: thread.id,
      runId,
      nodeId,
      providerThreadId,
      providerTurnId,
      nativeItemRef: string(
        items.find((item) => string(item.id) === id || string(item.clientId) === id)?.id,
      )
        ? nativeRef(
            string(
              items.find((item) => string(item.id) === id || string(item.clientId) === id)?.id,
            ),
          )
        : null,
      parentItemId: null,
      ordinal: ordinal++,
      status: itemStatus,
      title: null,
      startedAt,
      completedAt,
      updatedAt: running ? now : (completedAt ?? startedAt),
    });
    emit(
      "run.updated",
      {
        id: runId,
        threadId: thread.id,
        ordinal: context?.ordinal ?? index + 1,
        providerInstanceId: thread.providerInstanceId,
        modelSelection: turnModelSelection,
        providerThreadId,
        userMessageId,
        rootNodeId: nodeId,
        activeAttemptId: attemptId,
        status,
        requestedAt: startedAt,
        startedAt,
        completedAt,
        checkpointId: null,
        contextHandoffId: null,
      },
      runId,
      nodeId,
    );
    emit(
      "run-attempt.updated",
      {
        id: attemptId,
        nativeThreadId: nativeId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId: thread.providerInstanceId,
        providerThreadId,
        providerTurnId,
        reason: "initial",
        status,
        startedAt,
        completedAt,
      },
      runId,
      nodeId,
    );
    emit(
      "node.updated",
      {
        id: nodeId,
        threadId: thread.id,
        runId,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "root_turn",
        status,
        countsForRun: true,
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt,
      },
      runId,
      nodeId,
    );
    emit(
      "provider-turn.updated",
      {
        id: providerTurnId,
        providerThreadId,
        nodeId,
        runAttemptId: attemptId,
        nativeTurnRef: nativeRef(nativeTurnId),
        ordinal: context?.providerTurnOrdinal ?? index + 1,
        status,
        startedAt,
        completedAt,
        ...(actualModel ? { model: actualModel } : {}),
      },
      runId,
      nodeId,
    );
    const message = (
      id: string,
      role: "user" | "assistant" | "system",
      text: string,
      streaming: boolean,
    ) => {
      const messageId = id === userId ? userMessageId : `desktop-message:${nativeId}:${id}`;
      const notification =
        role === "system"
          ? {
              source: { kind: "system" },
              outcome: "updated",
              summary: "Codex app task message",
              detail: text,
            }
          : undefined;
      emit(
        "message.updated",
        {
          id: messageId,
          threadId: thread.id,
          runId,
          nodeId,
          createdBy: role === "user" ? "user" : role === "system" ? "agent" : "system",
          creationSource: "server",
          role,
          text,
          attachments: [],
          streaming,
          ...(notification ? { notification } : {}),
          createdAt: startedAt,
          updatedAt: running ? now : (completedAt ?? startedAt),
        },
        runId,
        nodeId,
      );
      if (notification) {
        emit(
          "turn-item.updated",
          { ...itemBase(id, "completed"), type: "notification", ...notification },
          runId,
          nodeId,
        );
        return;
      }
      emit(
        "turn-item.updated",
        {
          ...itemBase(id, role === "user" ? "completed" : status),
          type: role === "user" ? "user_message" : "assistant_message",
          messageId,
          text,
          ...(role === "user"
            ? {
                createdBy: "user",
                creationSource: "server",
                inputIntent: id === userId ? "turn_start" : "steer",
                attachments: [],
              }
            : { streaming }),
        },
        runId,
        nodeId,
      );
    };
    // Native optimistic starts hold input in params until the canonical user item arrives.
    if (!firstUser) {
      const text = inputText(params.input);
      const appTool = record(params.toolOutput);
      const toolOutput =
        params.turnTrigger === "app_tool_send_message" &&
        appTool.namespace === "codex_app" &&
        appTool.name === "send_message_to_thread"
          ? string(appTool.output)
          : "";
      if (text || toolOutput)
        message(userId, !text && toolOutput ? "system" : "user", text || toolOutput, false);
    }
    const latestTodo = items.findLast((item) => item.type === "todo-list");
    for (const [itemIndex, item] of items.entries()) {
      const id = string(item.clientId) || string(item.id) || `${nativeTurnId}:item:${itemIndex}`;
      if (item.type === "userMessage")
        message(item === firstUser ? userId : id, "user", inputText(item.content), false);
      else if (item.type === "steeringUserMessage")
        message(
          id,
          "user",
          inputText(item.input) || string(item.text) || inputText(item.content),
          false,
        );
      else if (item.type === "agentMessage")
        message(id, "assistant", string(item.text), running && item.status !== "completed");
      else if (item.type === "reasoning")
        emit(
          "turn-item.updated",
          {
            ...itemBase(id),
            type: "reasoning",
            text: inputText(item.summary) || inputText(item.content),
            streaming: running,
          },
          runId,
          nodeId,
        );
      else if (item.type === "commandExecution")
        emit(
          "turn-item.updated",
          {
            ...itemBase(id, item.status === "completed" ? "completed" : status),
            type: "command_execution",
            input: string(item.command),
            output: string(item.aggregatedOutput) || string(item.output),
            ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
          },
          runId,
          nodeId,
        );
      else if (item.type === "fileChange") {
        const fileStatus =
          item.status === "completed"
            ? "completed"
            : item.status === "failed"
              ? "failed"
              : item.status === "declined"
                ? "cancelled"
                : status === "completed"
                  ? "failed"
                  : status;
        // One item per original path keeps every diff available to the existing single-file viewer.
        const changes = list(item.changes)
          .map(record)
          .filter((change) => string(change.path).trim())
          .sort((a, b) => string(a.path).localeCompare(string(b.path)));
        const filePrefix = `desktop-item:${nativeId}:${id}:file:`;
        const currentIds = new Set(
          changes.map((change) => `${filePrefix}${encodeURIComponent(string(change.path).trim())}`),
        );
        for (const change of changes) {
          const kind = record(change.kind);
          const path = string(change.path).trim();
          const destination = string(kind.move_path).trim();
          emit(
            "turn-item.updated",
            {
              ...itemBase(`${id}:file:${encodeURIComponent(path)}`, fileStatus),
              nativeItemRef: string(item.id) ? nativeRef(string(item.id)) : null,
              type: "file_change",
              title:
                fileStatus === "failed" && item.status !== "failed"
                  ? "File change completion unconfirmed"
                  : null,
              fileName: destination || path,
              ...(typeof change.diff === "string" ? { diffStr: change.diff } : {}),
              changes: [
                {
                  operation: string(kind.type).trim() || "unknown",
                  path: destination || path,
                  ...(destination ? { oldPath: path } : {}),
                },
              ],
            },
            runId,
            nodeId,
          );
        }
        // Desktop replaces the complete changes array; an omitted path is no longer in this patch.
        if (Array.isArray(item.changes))
          for (const previous of history.fileItems.values()) {
            if (
              previous.runId !== runId ||
              !previous.id.startsWith(filePrefix) ||
              currentIds.has(previous.id)
            )
              continue;
            emit(
              "turn-item.updated",
              {
                ...previous,
                ...itemBase(previous.id, "cancelled"),
                id: previous.id,
                nativeItemRef: previous.nativeItemRef,
                title: "Removed from Desktop patch",
                diffStr: undefined,
                oldStr: undefined,
                newStr: undefined,
                additions: undefined,
                deletions: undefined,
              },
              runId,
              nodeId,
            );
          }
      } else if (item.type === "plan" || item.type === "todo-list") {
        const todo = item.type === "todo-list";
        const superseded = todo && item !== latestTodo;
        const planKey = id;
        const planId = `desktop-plan:${nativeId}:${planKey}`;
        const planNodeId = `desktop-plan-node:${nativeId}:${planKey}`;
        const steps = list(item.plan)
          .map((entry, index) => {
            const step = record(entry);
            return {
              id: `step-${index + 1}`,
              text: string(step.step).trim(),
              status:
                step.status === "completed"
                  ? "completed"
                  : step.status === "in_progress"
                    ? "running"
                    : "pending",
            };
          })
          .filter((step) => step.text);
        const complete = todo
          ? steps.length > 0 &&
            steps.length === list(item.plan).length &&
            steps.every((step) => step.status === "completed")
          : record(turn.completedItemIds)[string(item.id)] === true ||
            item.completed === true ||
            item.status === "completed";
        const planStatus = superseded
          ? "cancelled"
          : complete
            ? "completed"
            : status === "completed"
              ? "failed"
              : status;
        const detail = todo
          ? {
              steps,
              ...(typeof item.explanation === "string" ? { explanation: item.explanation } : {}),
            }
          : { markdown: string(item.text) };
        const base = {
          ...itemBase(planKey, planStatus),
          nodeId: planNodeId,
          nativeItemRef: string(item.id) ? nativeRef(string(item.id)) : null,
          title: superseded ? "Plan updated" : null,
          completedAt: planStatus === "running" ? null : completedAt,
        };
        emit(
          "node.updated",
          {
            id: planNodeId,
            threadId: thread.id,
            runId,
            parentNodeId: nodeId,
            rootNodeId: nodeId,
            kind: todo ? "todo_list" : "plan",
            status: planStatus,
            countsForRun: false,
            providerThreadId,
            providerTurnId,
            nativeItemRef: base.nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt: base.completedAt,
          },
          runId,
          planNodeId,
        );
        emit(
          "plan.updated",
          {
            id: planId,
            threadId: thread.id,
            runId,
            nodeId: planNodeId,
            kind: todo ? "todo_list" : "proposed_plan",
            status: superseded
              ? "superseded"
              : todo
                ? complete
                  ? "completed"
                  : "active"
                : complete
                  ? "active"
                  : "draft",
            ...detail,
          },
          runId,
          planNodeId,
        );
        emit(
          "turn-item.updated",
          {
            ...base,
            type: todo ? "todo_list" : "proposed_plan",
            planId,
            ...detail,
            ...(!todo ? { streaming: running && !complete } : {}),
          },
          runId,
          planNodeId,
        );
      } else if (
        item.type === "contextCompaction" &&
        string(item.id) &&
        item.id !== "pending-manual-context-compaction"
      ) {
        // Desktop inserts a synthetic placeholder before its execution process accepts the request.
        const compactionStatus =
          item.completed === true ? "completed" : status === "completed" ? "failed" : status;
        const itemStartedAt = timestamp(item.startedAtMs, startedAt);
        const itemCompletedAt =
          compactionStatus === "running"
            ? null
            : timestamp(item.completedAtMs, completedAt ?? itemStartedAt);
        emit(
          "turn-item.updated",
          {
            ...itemBase(id, compactionStatus),
            type: "compaction",
            driver: "codex",
            title:
              compactionStatus === "running"
                ? "Compacting context"
                : compactionStatus === "completed"
                  ? "Context compacted"
                  : status === "completed"
                    ? "Compaction completion unconfirmed"
                    : compactionStatus === "failed"
                      ? "Context compaction failed"
                      : "Context compaction stopped",
            startedAt: itemStartedAt,
            completedAt: itemCompletedAt,
            updatedAt: itemCompletedAt ?? itemStartedAt,
          },
          runId,
          nodeId,
        );
      }
    }
    for (const request of requests.filter((request) => request.turnId === nativeTurnId)) {
      const requestId = `desktop-request:${nativeId}:${request.key}`;
      const responseKey = desktopResponseKey(nativeId, desktopRequestRef(request));
      const requestNodeId = `desktop-request-node:${responseKey}`;
      const requestItemId = `desktop-request-item:${responseKey}`;
      const kind = desktopRequestKind(request);
      const params = record(request.raw.params);
      const pending = request.closedAtMs === null && request.epoch === input.epoch;
      const createdAt = DateTime.makeUnsafe(request.createdAtMs);
      const resolvedAt = pending ? null : DateTime.makeUnsafe(request.closedAtMs!);
      const saved = savedRequests.get(requestId);
      const ownerAnswer = items.find(
        (item) =>
          item.type === "userInputResponse" &&
          item.requestId === request.id &&
          item.turnId === request.turnId &&
          item.completed === true,
      );
      const ownerAnswers = ownerAnswer
        ? Object.fromEntries(
            Object.entries(record(ownerAnswer.answers)).filter(
              ([, value]) =>
                Array.isArray(value) && value.every((entry) => typeof entry === "string"),
            ),
          )
        : undefined;
      const responseSessionId = input.providerThread?.providerSessionId;
      const supported =
        !!desktopReplyMethod(request.method) &&
        (kind !== "user_input" ||
          (list(params.questions).length > 0 &&
            list(params.questions).every(
              (question) => string(record(question).id) && string(record(question).question),
            )));
      const uncertain = input.reservedResponseKeys?.has(responseKey);
      const responseCapability =
        supported && responseSessionId && !uncertain
          ? { type: "live", providerSessionId: responseSessionId, supportsFeedback: false }
          : {
              type: "not_resumable",
              reason: uncertain
                ? "A response was already forwarded. Wait for Desktop to resolve the request; it will not be resent."
                : supported
                  ? "Wait for the shared Desktop response session."
                  : "Answer this request in Codex Desktop.",
            };
      const requestStatus =
        request.epoch !== input.epoch
          ? "expired"
          : pending
            ? "pending"
            : saved?.status === "resolved"
              ? "resolved"
              : turn.status === "interrupted" || turn.status === "cancelled"
                ? "cancelled"
                : "resolved";
      emit(
        "node.updated",
        {
          id: requestNodeId,
          threadId: thread.id,
          runId,
          parentNodeId: nodeId,
          rootNodeId: nodeId,
          kind: kind === "user_input" ? "user_input_request" : "approval_request",
          status: requestStatus === "expired" ? "cancelled" : pending ? "waiting" : "completed",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: string(params.itemId) ? nativeRef(string(params.itemId)) : null,
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: resolvedAt,
        },
        runId,
        requestNodeId,
      );
      emit(
        "runtime-request.updated",
        {
          id: requestId,
          nodeId: requestNodeId,
          providerTurnId,
          nativeRequestRef: nativeRef(desktopRequestRef(request)),
          kind,
          status: requestStatus,
          responseCapability,
          createdAt,
          resolvedAt,
          ...(ownerAnswers ? { answers: ownerAnswers } : {}),
        },
        runId,
        requestNodeId,
      );
      const base = {
        ...itemBase(requestItemId, pending ? "waiting" : "completed"),
        id: requestItemId,
        nodeId: requestNodeId,
        startedAt: createdAt,
        completedAt: resolvedAt,
      };
      if (kind === "user_input") {
        const questions = list(params.questions)
          .map(record)
          .map((q, index) => ({
            id: string(q.id) || `question-${index + 1}`,
            header: string(q.header) || "Question",
            question: string(q.question) || "Input requested by Codex Desktop",
            options: list(q.options)
              .map(record)
              .filter((option) => string(option.label))
              .map((option) => ({
                label: string(option.label),
                description: string(option.description) || string(option.label),
              })),
            ...(typeof q.multiSelect === "boolean" ? { multiSelect: q.multiSelect } : {}),
            allowCustomAnswer: q.isOther !== false,
          }));
        emit(
          "turn-item.updated",
          {
            ...base,
            type: "user_input_request",
            requestId,
            questions,
            ...(ownerAnswers
              ? {
                  questionAnswer: {
                    requestId,
                    answers: ownerAnswers,
                    attachmentsByQuestionId: {},
                    questionTextById: Object.fromEntries(questions.map((q) => [q.id, q.question])),
                  },
                }
              : {}),
          },
          runId,
          requestNodeId,
        );
      } else {
        const available = list(params.availableDecisions);
        const options = [
          {
            decision: "accept",
            label:
              request.method === "item/permissions/requestApproval"
                ? "Allow for this turn"
                : "Allow once",
          },
          { decision: "acceptForSession", label: "Allow for this session" },
          { decision: "decline", label: "Decline" },
          { decision: "cancel", label: "Cancel" },
        ].filter((option) => !available.length || available.includes(option.decision));
        emit(
          "turn-item.updated",
          {
            ...base,
            type: "approval_request",
            requestId,
            requestKind: kind,
            prompt:
              [
                string(params.command),
                string(params.reason),
                string(params.cwd) ? `Working directory: ${string(params.cwd)}` : "",
                string(params.grantRoot) ? `Requested root: ${string(params.grantRoot)}` : "",
                request.method === "item/permissions/requestApproval"
                  ? `Requested permissions:\n${JSON.stringify(record(params.permissions), null, 2)}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n\n") || "Codex Desktop requests approval.",
            options,
          },
          runId,
          requestNodeId,
        );
      }
    }
  }
  for (const event of events)
    if (event.type === "turn-item.updated" && event.payload.type === "file_change")
      history.fileItems.set(event.payload.id, event.payload);
  return events;
}

/** Ignore publication timestamps when deciding whether a persisted fact changed. */
export function desktopEventFingerprint(event: OrchestrationV2DomainEvent) {
  return desktopFactFingerprint(event.payload);
}

export function desktopFactFingerprint(payload: unknown) {
  return JSON.stringify(payload, (key, value) => (key === "updatedAt" ? undefined : value));
}
