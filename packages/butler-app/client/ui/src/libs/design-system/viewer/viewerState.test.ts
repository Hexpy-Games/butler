/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { DEFAULT_VIEWER_STATE, parseViewerState, viewerSearchString } from "./viewerState";

describe("DS Viewer URL state", () => {
  test("falls back to defaults when the URL only selects the viewer", () => {
    expect(parseViewerState("?visual=design-system")).toEqual(DEFAULT_VIEWER_STATE);
    expect(DEFAULT_VIEWER_STATE).toEqual({ page: "overview", theme: "system", locale: "en", width: "app" });
  });

  test("reads page, theme, locale, and width deep-link params", () => {
    expect(parseViewerState("?visual=design-system&page=components/Button&theme=side-by-side&locale=ko&width=375"))
      .toEqual({ page: "components/Button", theme: "side-by-side", locale: "ko", width: "375" });
  });

  test("ignores unknown theme, locale, and width values", () => {
    expect(parseViewerState("?page=blocks&theme=sepia&locale=fr&width=999"))
      .toEqual({ ...DEFAULT_VIEWER_STATE, page: "blocks" });
  });

  test("writes only non-default values and keeps unrelated params", () => {
    const search = viewerSearchString("?visual=design-system&debug=1&theme=dark", {
      ...DEFAULT_VIEWER_STATE,
      page: "components/Button",
      width: "320",
    });

    expect(search).toBe("?visual=design-system&debug=1&page=components%2FButton&width=320");
  });

  test("round-trips every toolbar value", () => {
    const state = { page: "blocks/NavRow", theme: "dark", locale: "ko", width: "wide" } as const;

    expect(parseViewerState(viewerSearchString("?visual=design-system", state))).toEqual(state);
  });
});
