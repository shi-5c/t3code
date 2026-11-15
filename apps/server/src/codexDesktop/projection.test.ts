import { expect, it } from "vite-plus/test";
import { projectDesktopConversation } from "./projection.ts";

it.each([
  ["never", "dangerFullAccess", "full-access"],
  ["untrusted", "readOnly", "approval-required"],
  ["on-request", "workspaceWrite", null],
  [null, null, null],
] as const)(
  "reports current Desktop permissions %s/%s without borrowing an old turn",
  (approvalPolicy, sandboxMode, runtimeMode) => {
    const result = projectDesktopConversation({
      currentPermissions: {
        approvalPolicy,
        sandboxPolicy: sandboxMode === null ? null : { type: sandboxMode },
      },
      turns: [{ params: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } }],
    });
    expect(result.permissions).toEqual({ approvalPolicy, sandboxMode, runtimeMode });
  },
);

it("uses canonical island order and renders a user input only once during optimistic reconciliation", () => {
  const first = {
    turnId: "one",
    status: "completed",
    params: { input: [{ type: "text", text: "Question" }] },
    items: [
      { type: "userMessage", clientId: "user-1", content: [{ text: "Question" }] },
      { type: "agentMessage", id: "answer-1", text: "Answer" },
    ],
  };
  const second = {
    turnId: "two",
    status: "inProgress",
    params: { clientUserMessageId: "user-2", input: [{ text: "Follow up" }] },
    items: [],
  };
  const result = projectDesktopConversation({
    title: "Shared",
    turns: [],
    turnHistory: {
      history: {
        entitiesByKey: { second, first },
        islands: [{ entries: [{ key: "first" }, { key: "second" }] }],
        isComplete: true,
      },
    },
  });
  expect(result.messages.map((message) => message.text)).toEqual([
    "Question",
    "Answer",
    "Follow up",
  ]);
  expect(result.messages.at(-1)?.id).toBe("user-2");
  expect(result.activeTurnId).toBe("two");
});

it("bounds history sent to remote clients while preserving the latest output", () => {
  const result = projectDesktopConversation({
    turns: [
      {
        items: Array.from({ length: 400 }, (_, i) => ({
          type: "agentMessage",
          id: `${i}`,
          text: `answer ${i}`,
        })),
      },
    ],
  });
  expect(result.messages).toHaveLength(300);
  expect(result.messages.at(-1)?.text).toBe("answer 399");
  expect(result.truncated).toBe(true);
});
