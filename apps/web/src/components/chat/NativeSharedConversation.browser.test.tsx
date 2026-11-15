import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, ProviderDriverKind } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { NativeSharedConversation } from "./NativeSharedConversation";

const state = vi.hoisted(() => ({ open: vi.fn(), refresh: vi.fn(), attach: vi.fn() }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: state.open } }),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string | { kind: string }) =>
    typeof command !== "string" && command.kind === "attach" ? state.attach : state.refresh,
}));
vi.mock("../../state/agentSessions", () => ({ agentSessionImport: "refresh" }));
vi.mock("../../state/codexDesktop", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    codexDesktopEnvironment: {
      attachExisting: { kind: "attach", permissionAtom: () => Atom.make(true) },
    },
  };
});

function setup() {
  state.open.mockReset().mockResolvedValue(undefined);
  state.attach
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { threadId: "app-thread", uncertain: [] } });
  state.refresh
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { importedCount: 1, skippedCount: 0 } });
  return {
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("project"),
    threadId: ThreadId.make("app-thread"),
    nativeId: "00000000-0000-4000-8000-000000000001",
    creationUnknown: false,
    title: "Shared test",
    titleVersion: 0,
    titlePreparation: undefined,
    busy: false,
    canOpenLocally: true,
    provider: { driver: ProviderDriverKind.make("codex"), config: {} },
  };
}

it("opens the exact native ID only after confirmed release and explicit click", async () => {
  const props = setup();
  await using screen = await render(
    <NativeSharedConversation {...props} releaseState={undefined} />,
  );
  const button = screen.getByRole("button", { name: "Open in Codex Desktop" });
  await expect.element(button).toBeDisabled();
  await screen.getByRole("button", { name: "Check release" }).click();
  expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
    environmentId: props.environmentId,
    input: { projectId: props.projectId, threadId: props.threadId, reconcileRelease: true },
  });
  await screen.rerender(<NativeSharedConversation {...props} releaseState="held" />);
  await expect.element(button).toBeDisabled();
  await screen.rerender(<NativeSharedConversation {...props} releaseState="pending" />);
  await expect.element(button).toBeDisabled();
  await screen.rerender(<NativeSharedConversation {...props} releaseState="unknown" />);
  await expect.element(button).toBeDisabled();
  await screen.rerender(<NativeSharedConversation {...props} releaseState="ready" />);
  await expect.element(button).toBeEnabled();
  expect(state.open).not.toHaveBeenCalled();
  await button.click();
  expect(state.open).toHaveBeenCalledExactlyOnceWith(`codex://threads/${props.nativeId}`);
  await screen.rerender(
    <NativeSharedConversation
      {...props}
      releaseState="ready"
      provider={{ ...props.provider, config: { homePath: "C:/custom-codex" } }}
    />,
  );
  await expect.element(button).toBeDisabled();
});

it("connects the existing thread explicitly and displays a failed handoff without sending input", async () => {
  const props = setup();
  await using screen = await render(<NativeSharedConversation {...props} releaseState="unknown" />);
  const button = screen.getByRole("button", { name: "Connect to Desktop" });
  await expect.element(button).toBeDisabled();
  await screen.rerender(<NativeSharedConversation {...props} releaseState="ready" />);
  expect(state.attach).not.toHaveBeenCalled();
  state.attach.mockRejectedValueOnce(new Error("Open this conversation in Codex Desktop"));
  await button.click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Open this conversation in Codex Desktop");
  await button.click();
  expect(state.attach).toHaveBeenLastCalledWith({
    environmentId: props.environmentId,
    input: { threadId: props.threadId, conversationId: props.nativeId },
  });
  expect(state.refresh).not.toHaveBeenCalled();
  expect(state.open).not.toHaveBeenCalled();
});

it("shows an opening failure and allows a retry without sending a conversation message", async () => {
  const props = setup();
  state.open.mockRejectedValueOnce(new Error("Codex is unavailable"));
  await using screen = await render(<NativeSharedConversation {...props} releaseState="ready" />);
  const button = screen.getByRole("button", { name: "Open in Codex Desktop" });
  await button.click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Codex is unavailable");
  await expect.element(button).toBeEnabled();
  await button.click();
  expect(state.open).toHaveBeenCalledTimes(2);
  expect(state.refresh).not.toHaveBeenCalled();
});

it("allows an observed saved title after release and blocks a later manual intent", async () => {
  const props = {
    ...setup(),
    title: "B",
    titleVersion: 2,
    titleSource: "saved" as const,
    titlePreparation: {
      status: "saved" as const,
      desiredTitle: "A",
      observedTitle: "A",
      version: 1,
    },
  };
  await using screen = await render(<NativeSharedConversation {...props} releaseState="ready" />);
  const open = screen.getByRole("button", { name: "Open in Codex Desktop" });
  const connect = screen.getByRole("button", { name: "Connect to Desktop" });
  await expect.element(open).toBeEnabled();
  await expect.element(connect).toBeEnabled();
  await open.click();
  await connect.click();
  expect(state.open).toHaveBeenCalledExactlyOnceWith(`codex://threads/${props.nativeId}`);
  expect(state.attach).toHaveBeenCalledTimes(1);
  await screen.rerender(
    <NativeSharedConversation
      {...{ ...props, title: "C", titleVersion: 3, titleSource: "manual" as const }}
      releaseState="ready"
    />,
  );
  await expect.element(open).toBeDisabled();
  await expect.element(connect).toBeDisabled();
});

it.each(["pending", "unknown", "unverified"] as const)(
  "blocks Desktop opening and handoff while the native title is %s",
  async (status) => {
    const props = setup();
    await using screen = await render(
      <NativeSharedConversation
        {...props}
        {...{ titleSource: "saved" as const }}
        releaseState="ready"
        titlePreparation={{ status, version: 0, desiredTitle: props.title, observedTitle: null }}
      />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Open in Codex Desktop" }))
      .toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Connect to Desktop" })).toBeDisabled();
    await screen.getByRole("button", { name: "Check release" }).click();
    expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, threadId: props.threadId, reconcileRelease: true },
    });
    expect(state.open).not.toHaveBeenCalled();
    expect(state.attach).not.toHaveBeenCalled();
  },
);
