import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { EnvironmentId, type CodexDesktopHistoryPage } from "@t3tools/contracts";
import { act, render } from "../../../test/render";
import { DesktopSavedHistory } from "./DesktopSavedHistory";
import { DesktopHistoryPreview } from "./DesktopHistoryPreview";

const state = vi.hoisted(() => ({ page: vi.fn(), library: vi.fn(), refresh: vi.fn() }));
vi.mock("../../state/codexDesktop", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    codexDesktopHostAtom: Atom.make(null),
    codexDesktopEnvironment: { historyPage: state.page, historyLibrary: state.library },
  };
});

it("keeps the picker preview pinned when the same native ID appears in another source", async () => {
  state.page.mockReset();
  const environmentId = EnvironmentId.make("preview-host");
  const sourceId = "a".repeat(64);
  state.page.mockReturnValue(
    Atom.make(
      AsyncResult.success({
        conversationId: "native",
        thread: { id: "native" },
        entries: [
          {
            turn: { id: "turn" },
            item: { id: "answer", type: "agentMessage", text: "Pinned source answer" },
          },
        ],
        totalItems: 1,
        nextCursor: null,
      }),
    ),
  );
  const libraryAtom = Atom.make(
    AsyncResult.success({ entries: [{ conversationId: "native", sourceId, title: "Original" }] }),
  );
  state.library.mockReturnValue(libraryAtom);
  const registry = AtomRegistry.make();
  const props = { environmentId, conversationId: "native", sourceId, onClose: () => {} };
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <DesktopHistoryPreview {...props} />
    </RegistryContext.Provider>,
  );
  await expect.element(page.getByText("Pinned source answer", { exact: true })).toBeVisible();
  await act(() =>
    registry.set(
      libraryAtom,
      AsyncResult.success({
        entries: [{ conversationId: "native", sourceId: "b".repeat(64), title: "Other source" }],
      }),
    ),
  );
  await expect
    .element(
      page.getByText(
        "This saved history source is unavailable. Refresh the library and reopen the conversation.",
      ),
    )
    .toBeVisible();
  expect(
    state.page.mock.calls.every(
      ([input]) => input.environmentId === environmentId && input.input.sourceId === sourceId,
    ),
  ).toBe(true);
  await expect
    .element(page.getByText("Pinned source answer", { exact: true }))
    .not.toBeInTheDocument();
  await screen.unmount();
  registry.dispose();
});

it("keeps the loaded snapshot on page failure and resets paging when the environment or source changes", async () => {
  state.page.mockReset();
  state.library.mockReset();
  state.refresh.mockReset();
  const environmentId = EnvironmentId.make("host-a");
  const otherEnvironment = EnvironmentId.make("host-b");
  const sourceId = "a".repeat(64);
  const snapshot = "c".repeat(64);
  const first: CodexDesktopHistoryPage = {
    conversationId: "native",
    thread: { id: "native" },
    entries: [
      {
        turn: { id: "turn" },
        item: { id: "answer", type: "agentMessage", text: "Complete saved answer" },
      },
    ],
    totalItems: 26,
    nextCursor: { snapshot, offset: 25 },
  };
  const firstAtom = Atom.make(AsyncResult.success(first));
  const failedAtom = Atom.make(AsyncResult.failure(Cause.fail(new Error("offline"))));
  const otherAtom = Atom.make(
    AsyncResult.success({
      ...first,
      nextCursor: null,
      entries: [
        {
          turn: { id: "other" },
          item: { id: "other-answer", type: "agentMessage", text: "Other source answer" },
        },
      ],
    }),
  );
  const libraryAtom = Atom.make(AsyncResult.success({ entries: [] }));
  state.library.mockReturnValue(libraryAtom);
  state.page.mockImplementation(({ environmentId: environment, input }) =>
    environment === otherEnvironment ? otherAtom : input.cursor ? failedAtom : firstAtom,
  );
  await using screen = await render(
    <DesktopSavedHistory
      key={`${environmentId}:${sourceId}:native`}
      environmentId={environmentId}
      sourceId={sourceId}
      conversationId="native"
    />,
  );
  await expect.element(screen.getByText("Complete saved answer", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Next", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await expect.element(screen.getByText("Complete saved answer", { exact: true })).toBeVisible();
  expect(state.page).toHaveBeenCalledWith({
    environmentId,
    input: { conversationId: "native", sourceId, cursor: { snapshot, offset: 25 } },
  });
  await expect.element(screen.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await screen.getByRole("button", { name: "Previous", exact: true }).click();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await screen.rerender(
    <DesktopSavedHistory
      key={`${otherEnvironment}:b:native`}
      environmentId={otherEnvironment}
      sourceId={"b".repeat(64)}
      conversationId="native"
    />,
  );
  await expect.element(screen.getByText("Other source answer", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("Complete saved answer", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Previous", exact: true }))
    .toBeDisabled();
  expect(state.page).toHaveBeenLastCalledWith({
    environmentId: otherEnvironment,
    input: { conversationId: "native", sourceId: "b".repeat(64), cursor: undefined },
  });
});
