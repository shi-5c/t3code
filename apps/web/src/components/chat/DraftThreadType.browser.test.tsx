import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import type { DraftId } from "../../composerDraftStore";
import { DraftThreadType } from "./DraftThreadType";

const state = vi.hoisted(() => ({
  host: "environment-b",
  navigate: vi.fn(),
  draft: { environmentId: "environment-a", threadType: "codex-shared" },
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    set: (_atom: unknown, value: string) => {
      state.host = value;
    },
  },
}));
vi.mock("../../state/codexDesktop", () => ({
  codexDesktopHostAtom: "desktop-host",
  codexDesktopEnvironment: {},
}));
vi.mock("../../composerDraftStore", () => {
  const store = { getDraftSession: () => state.draft };
  return {
    DraftId: { make: (value: string) => value },
    useComposerDraftStore: Object.assign((select: (s: typeof store) => unknown) => select(store), {
      getState: () => store,
    }),
  };
});

it("opens the draft environment instead of the previously selected Desktop host", async () => {
  state.host = "environment-b";
  state.navigate.mockReset();
  let hostAtNavigation: string | undefined;
  state.navigate.mockImplementation(() => {
    hostAtNavigation = state.host;
    return Promise.resolve();
  });
  await using _screen = await render(<DraftThreadType draftId={"draft-a" as DraftId} />);
  await page.getByRole("button", { name: "connect it to T3" }).click();
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/codex-desktop",
    search: { conversationId: undefined },
  });
  expect(state.host).toBe("environment-a");
  expect(hostAtNavigation).toBe("environment-a");
});
