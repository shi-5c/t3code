import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CodexDesktopSend, CodexDesktopTarget } from "./codexDesktop.ts";
import { AuthOrchestrationOperateScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

it("bounds remote inputs and excludes paths from conversation identifiers", () => {
  const target = Schema.decodeUnknownSync(CodexDesktopTarget);
  expect(target({ conversationId: "01a1-test" })).toEqual({ conversationId: "01a1-test" });
  expect(() => target({ conversationId: "../../sessions" })).toThrow();
  const send = Schema.decodeUnknownSync(CodexDesktopSend);
  const input = {
    conversationId: "test",
    clientMessageId: "message",
    text: "hi",
    expectedTurnId: null,
  };
  expect(send(input)).toEqual(input);
  expect(() => send({ ...input, text: "x".repeat(64_001) })).toThrow();
  expect(() => send({ ...input, expectedTurnId: undefined })).toThrow();
});

it("requires operation permission for both Desktop mutations", () => {
  for (const method of [WS_METHODS.codexDesktopSend, WS_METHODS.codexDesktopStop]) {
    expect(clientRpcRequiredScopes(method, {})).toEqual([AuthOrchestrationOperateScope]);
  }
});
