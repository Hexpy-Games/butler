import { describe, expect, test } from "bun:test";
import {
    adaptiveDrawerQuery,
    classifyAdaptiveMode,
    normalizeAdaptivePanelState,
    restoreAdaptivePanelState,
} from "../../packages/butler-app/client/ui/src/libs/design-system/responsive";
describe("responsive adaptive design contracts", () => {
  test("classifies canonical shell widths", () => {
    expect(classifyAdaptiveMode(320)).toBe("compact");
    expect(classifyAdaptiveMode(640)).toBe("compact");
    expect(classifyAdaptiveMode(641)).toBe("medium");
    expect(classifyAdaptiveMode(1023)).toBe("medium");
    expect(classifyAdaptiveMode(1024)).toBe("expanded");
    expect(classifyAdaptiveMode(800, "electron")).toBe("expanded");
    expect(classifyAdaptiveMode(640, "electron")).toBe("compact");
    expect(adaptiveDrawerQuery("electron")).toBe("(max-width: 640px)");
    expect(adaptiveDrawerQuery("browser")).toBe("(max-width: 1023px)");
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
});
