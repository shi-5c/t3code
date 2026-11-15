import { expect, it } from "vite-plus/test";
import { ownerTurnRequest } from "./ownerTurnRequest.ts";

it("preserves content and model choices without forwarding T3 permission or workspace overrides", () => {
  const request = ownerTurnRequest({
    threadId: "restricted-owner",
    input: [{ type: "text", text: "hello" }],
    model: "gpt-6-luna",
    effort: "low",
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandboxPolicy: { type: "dangerFullAccess" },
    permissions: ":danger-full-access",
    cwd: "another-workspace",
    runtimeWorkspaceRoots: ["C:/"],
    environments: [{ cwd: "C:/" }],
  });
  expect(request).toEqual({
    threadId: "restricted-owner",
    input: [{ type: "text", text: "hello" }],
    model: "gpt-6-luna",
    effort: "low",
  });
});
