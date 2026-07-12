import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyAdaptiveMode,
  normalizeAdaptivePanelState,
  restoreAdaptivePanelState,
} from "../../packages/butler-app/client/ui/src/libs/design-system/responsive";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("responsive adaptive design contracts", () => {
  test("classifies canonical shell widths", () => {
    expect(classifyAdaptiveMode(320)).toBe("compact");
    expect(classifyAdaptiveMode(640)).toBe("compact");
    expect(classifyAdaptiveMode(641)).toBe("medium");
    expect(classifyAdaptiveMode(1023)).toBe("medium");
    expect(classifyAdaptiveMode(1024)).toBe("expanded");
  });

  test("starts compact and medium shells with overlays closed", () => {
    expect(
      restoreAdaptivePanelState({
        mode: "compact",
        leftOpen: true,
        rightOpen: true,
      }),
    ).toEqual({ leftOpen: false, rightOpen: false });
    expect(
      restoreAdaptivePanelState({
        mode: "expanded",
        leftOpen: true,
        rightOpen: true,
      }),
    ).toEqual({ leftOpen: true, rightOpen: true });
  });

  test("keeps compact panels mutually exclusive", () => {
    expect(
      normalizeAdaptivePanelState({
        mode: "compact",
        requested: "left",
        leftOpen: false,
        rightOpen: true,
      }),
    ).toEqual({ leftOpen: true, rightOpen: false });
    expect(
      normalizeAdaptivePanelState({
        mode: "compact",
        requested: "right",
        leftOpen: true,
        rightOpen: false,
      }),
    ).toEqual({ leftOpen: false, rightOpen: true });
    expect(
      normalizeAdaptivePanelState({
        mode: "expanded",
        requested: "right",
        leftOpen: true,
        rightOpen: false,
      }),
    ).toEqual({ leftOpen: true, rightOpen: true });
  });

  test("moves the new-chat mark into compact metadata without reserving its desktop gutter", () => {
    const component = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/PromptSuggestionList/PromptSuggestionList.tsx",
    );
    const styles = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/PromptSuggestionList/PromptSuggestionList.module.css",
    );

    expect(component).toContain('data-slot="prompt-suggestion-compact-title-icon"');
    expect(component).toContain("styles.metaRow");
    expect(styles).toContain("--prompt-edge-gutter: var(--adaptive-page-gutter)");
    expect(styles).toContain(".compactTitleIcon");
    expect(styles).toContain(".titleIcon");
  });

  test("raises the compact readable type scale by two pixels through DS tokens", () => {
    const tokens = read(
      "packages/butler-app/client/ui/src/libs/design-system/tokens.css",
    );

    expect(tokens).toContain("--typo-body-size: 16px");
    expect(tokens).toContain("--typo-caption-size: 14px");
    expect(tokens).toContain("--typo-label-size: 15px");
    expect(tokens).toContain("--font-size-1: 14px");
    expect(tokens).toContain("--font-size-2: 15px");
    expect(tokens).toContain("--font-size-3: 16px");
    expect(tokens).toContain("--font-size-4: 17px");
  });
});
