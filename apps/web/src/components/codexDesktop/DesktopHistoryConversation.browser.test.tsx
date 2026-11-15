import { expect, it, vi } from "vite-plus/test";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { StrictMode } from "react";
import { act, render } from "../../../test/render";
import { DesktopOwnerPermissions, useDesktopHistoryConnection } from "./DesktopHistoryConversation";

const state = vi.hoisted(() => ({ attach: vi.fn(), watch: vi.fn(), library: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.attach }));
vi.mock("../../state/codexDesktop", async () => {
  const { Atom } = await import("effect/reactivity");
  const permission = Atom.make(true);
  return {
    codexDesktopHostAtom: Atom.make(null),
    codexDesktopEnvironment: {
      attachExisting: { permissionAtom: () => permission },
      watch: state.watch,
      historyLibrary: state.library,
    },
  };
});

function Connection({ nativeId, revision = 0 }: { nativeId: string; revision?: number }) {
  const connection = useDesktopHistoryConnection({
    environmentId: EnvironmentId.make("host"),
    threadId: ThreadId.make(nativeId),
    nativeId,
    sourceId: "a".repeat(64),
  });
  return (
    <div>
      <span>{revision}</span>
      <output>{connection.ready ? "ready" : connection.error || "waiting"}</output>
      <button onClick={() => void connection.connect()}>Retry</button>
    </div>
  );
}

it("shows live Desktop permissions and stops presenting them as current after disconnect", async () => {
  const permissions = {
    approvalPolicy: "never",
    sandboxMode: "dangerFullAccess",
    runtimeMode: "full-access",
  };
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  // A live stream remains waiting after each successful event until it ends.
  const ready = AsyncResult.success<{ status: string; permissions: typeof permissions }, string>(
    { status: "ready", permissions },
    { waiting: true },
  );
  const owner = Atom.make<AsyncResult.AsyncResult<typeof ready.value, string>>(ready);
  state.watch.mockReturnValue(owner);
  const view = (
    <RegistryContext.Provider value={registry}>
      <DesktopOwnerPermissions environmentId={EnvironmentId.make("host")} nativeId="permissions" />
    </RegistryContext.Provider>
  );
  const hint = "Shared messages use Desktop permissions. Change them in Codex Desktop.";
  await using screen = await render(view, { router: false }); // Live owner state has no routing dependency.
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(`Desktop permissions: Full access · Approvals: Never. ${hint}`);
  await act(() =>
    registry.set(owner, AsyncResult.success({ status: "reconnecting", permissions })),
  );
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(`Desktop permissions are currently unavailable. ${hint}`);
  await act(() =>
    registry.set(owner, AsyncResult.waiting(AsyncResult.success({ status: "ready", permissions }))),
  );
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(`Desktop permissions: Full access · Approvals: Never. ${hint}`);
  await act(() =>
    registry.set(
      owner,
      AsyncResult.fail("Connection lost", { previousSuccess: Option.some(ready) }),
    ),
  );
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(`Desktop permissions are currently unavailable. ${hint}`);
});

it.each(["success", "failure"])(
  "settles one automatic attachment on %s and ignores an old identity acknowledgement",
  async (outcome) => {
    state.attach.mockReset();
    const acknowledgements: Array<{
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }> = [];
    state.attach.mockImplementation(
      () => new Promise((resolve, reject) => acknowledgements.push({ resolve, reject })),
    );
    state.watch.mockReturnValue(Atom.make(AsyncResult.success({ status: "ready" })));
    state.library.mockReturnValue(
      Atom.make(
        AsyncResult.success({
          syncAvailable: true,
          entries: ["a", "b", "c"].map((conversationId) => ({
            conversationId,
            sourceId: "a".repeat(64),
          })),
        }),
      ),
    );
    await using screen = await render(
      <StrictMode>
        <Connection nativeId="a" />
      </StrictMode>,
      { router: false },
    );
    await vi.waitFor(() => expect(state.attach).toHaveBeenCalledTimes(1));
    if (outcome === "success") acknowledgements[0]!.resolve({ _tag: "Success" });
    else acknowledgements[0]!.reject(new Error("Owner offline"));
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent(outcome === "success" ? "ready" : "Owner offline");
    await screen.rerender(
      <StrictMode>
        <Connection nativeId="a" revision={1} />
      </StrictMode>,
    );
    expect(state.attach).toHaveBeenCalledTimes(1);
    await screen.rerender(
      <StrictMode>
        <Connection nativeId="b" />
      </StrictMode>,
    );
    await vi.waitFor(() => expect(state.attach).toHaveBeenCalledTimes(2));
    await screen.rerender(
      <StrictMode>
        <Connection nativeId="c" />
      </StrictMode>,
    );
    await vi.waitFor(() => expect(state.attach).toHaveBeenCalledTimes(3));
    acknowledgements[2]!.resolve({ _tag: "Success" });
    await expect.element(screen.getByRole("status")).toHaveTextContent("ready");
    acknowledgements[1]!.reject(new Error("Stale identity error"));
    await screen.rerender(
      <StrictMode>
        <Connection nativeId="c" revision={2} />
      </StrictMode>,
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("ready");
    expect(state.attach).toHaveBeenCalledTimes(3);
  },
);
