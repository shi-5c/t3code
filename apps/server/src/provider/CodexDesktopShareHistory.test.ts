import { MessageId, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import type { V2ThreadTurnsListResponse__Turn } from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";

import { projectDesktopShareHistory } from "./CodexDesktopShareHistory.ts";

it("backfills Desktop turns once and keeps messages already sent from T3", () => {
  const turns: ReadonlyArray<V2ThreadTurnsListResponse__Turn> = [
    {
      id: "native-owned-turn",
      status: "completed",
      items: [{ id: "native-owned-answer", type: "agentMessage", text: "Already projected" }],
    },
    {
      id: "native-missed-turn",
      status: "completed",
      items: [
        { id: "native-user-input", type: "userMessage", clientId: "t3-user-input", content: [] },
        { id: "native-missed-answer", type: "agentMessage", text: "Recovered answer" },
      ],
    },
    {
      id: "native-desktop-turn",
      status: "completed",
      items: [
        { id: "native-desktop-answer", type: "agentMessage", text: "Desktop answer" },
        { id: "native-desktop-answer", type: "agentMessage", text: "Desktop answer" },
        {
          id: "native-desktop-command",
          type: "commandExecution",
          cwd: "/example/project",
          command: "Get-Location",
          commandActions: [],
          status: "declined",
        },
      ],
    },
    {
      id: "native-in-progress",
      status: "inProgress",
      items: [{ id: "native-partial-answer", type: "agentMessage", text: "Partial" }],
    },
  ];
  const threadId = ThreadId.make("shared-thread");
  const messageId = MessageId.make("t3-user-input");
  const input: Parameters<typeof projectDesktopShareHistory>[0] = {
    threadId,
    providerThread: { id: ProviderThreadId.make("native-provider-thread") },
    nativeCreatedAt: 1,
    turns,
    ownedTurnIds: new Set(["native-owned-turn"]),
    existingItems: new Set(),
    existingNativeItems: new Map(),
    existingMessages: new Map([
      [
        messageId,
        {
          id: messageId,
          threadId,
          runId: null,
          nodeId: null,
          role: "user" as const,
          text: "Sent before the network dropped",
          attachments: [],
          streaming: false,
          createdBy: "user" as const,
          creationSource: "web" as const,
          createdAt: DateTime.makeUnsafe(1_000),
          updatedAt: DateTime.makeUnsafe(1_000),
        },
      ],
    ]),
  };
  const first = projectDesktopShareHistory(input);
  assert.deepEqual(
    first.flatMap((event) => (event.type === "message.updated" ? [event.payload.text] : [])),
    ["Recovered answer", "Desktop answer"],
  );
  const items = first.flatMap((event) =>
    event.type === "turn-item.updated" ? [event.payload] : [],
  );
  assert.lengthOf(items, 3);
  assert.equal(items.find((item) => item.type === "command_execution")?.status, "cancelled");
  assert.equal(new Set(first.map((event) => event.id)).size, first.length);
  assert.isEmpty(
    projectDesktopShareHistory({
      ...input,
      existingItems: new Set(items.map((item) => item.id)),
    }),
  );
});
