import { expect, it } from "vite-plus/test";
import { nativeTitleHandoffState } from "./threadType.ts";

it("distinguishes a saved observation from new local intent without excusing uncertain writes", () => {
  const current = {
    title: "B",
    titleVersion: 2,
    titleSource: "saved" as const,
    preparation: { status: "saved", desiredTitle: "A", version: 1 },
  };
  expect(nativeTitleHandoffState(current)).toBe("ready");
  expect(
    nativeTitleHandoffState({ ...current, title: "C", titleVersion: 3, titleSource: "manual" }),
  ).toBe("stale");
  for (const status of ["pending", "unknown", "unverified"])
    expect(
      nativeTitleHandoffState({ ...current, preparation: { ...current.preparation, status } }),
    ).toBe("unconfirmed");
  expect(
    nativeTitleHandoffState({
      ...current,
      titleSource: "manual",
      preparation: { status: "saved", desiredTitle: "B", version: 2 },
    }),
  ).toBe("ready");
});
