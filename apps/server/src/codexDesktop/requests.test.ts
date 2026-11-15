import { RuntimeRequestId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  DesktopRequestHistory,
  desktopRequestRef,
  parseDesktopRequestRef,
  desktopRequestResponse,
} from "./requests.ts";

const requestId = RuntimeRequestId.make("request");
it("keeps numeric and string request IDs distinct across turns and connection epochs", () => {
  const history = new DesktopRequestHistory();
  const raw = { id: 7, method: "item/tool/requestUserInput", params: { turnId: "turn" } };
  const first = history.update({ requests: [raw, { ...raw, id: "7" }] }, "epoch1", 1);
  expect(new Set(first.map((r) => r.key)).size).toBe(2);
  expect(parseDesktopRequestRef(desktopRequestRef(first[0]!)).id).toBe(7);
  const reconnected = history.update({ requests: [raw] }, "epoch2", 2);
  expect(reconnected.filter((r) => r.closedAtMs === null)).toHaveLength(1);
  expect(reconnected.filter((r) => r.epoch === "epoch1").every((r) => r.closedAtMs === 2)).toBe(
    true,
  );
});

it("grants only requested permissions with an explicit duration, and rejects expanded decisions", () => {
  const permissions = { fileSystem: { read: ["C:/test"], write: [] } };
  const raw = { method: "item/permissions/requestApproval", params: { permissions } };
  expect(desktopRequestResponse(raw, { requestId, decision: "accept" })).toEqual({
    response: { permissions, scope: "turn" },
  });
  expect(desktopRequestResponse(raw, { requestId, decision: "acceptForSession" })).toEqual({
    response: { permissions, scope: "session" },
  });
  expect(desktopRequestResponse(raw, { requestId, decision: "decline" })).toEqual({
    response: { permissions: {}, scope: "turn" },
  });
  expect(() => desktopRequestResponse(raw, { requestId, decision: "acceptAlways" })).toThrow(
    "explicit session",
  );
  expect(() =>
    desktopRequestResponse(raw, { requestId, decision: "accept", feedback: "text" }),
  ).toThrow("feedback");
  expect(() =>
    desktopRequestResponse(
      {
        method: "item/commandExecution/requestApproval",
        params: { availableDecisions: ["decline"] },
      },
      { requestId, decision: "accept" },
    ),
  ).toThrow("does not offer");
  expect(() =>
    desktopRequestResponse({ method: "unsupported" }, { requestId, decision: "accept" }),
  ).toThrow("in Codex Desktop");
  expect(() =>
    desktopRequestResponse(
      { method: "item/fileChange/requestApproval", params: { reason: "Change files" } },
      { requestId, decision: "accept" },
    ),
  ).toThrow("in Codex Desktop");
});

it("requires current questions and complete normalized answers", () => {
  const raw = {
    method: "item/tool/requestUserInput",
    params: { questions: [{ id: "q", question: "Choose?" }] },
  };
  const answers = { q: { answers: ["A"] } };
  expect(desktopRequestResponse(raw, { requestId, answers: { q: "A" } }, answers)).toEqual({
    response: { answers },
  });
  expect(() =>
    desktopRequestResponse(raw, { requestId, answers: { stale: "A" } }, answers),
  ).toThrow("changed");
  expect(() => desktopRequestResponse(raw, { requestId, answers: {} })).toThrow("every question");
});
