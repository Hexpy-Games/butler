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

    expect(component).toContain(
      'data-slot="prompt-suggestion-compact-title-icon"',
    );
    expect(component).toContain("styles.metaRow");
    expect(styles).toContain(
      "--prompt-edge-gutter: var(--adaptive-page-gutter)",
    );
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

  test("keeps the adaptive scrim on a stable compositor layer", () => {
    const component = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/AdaptiveShell/AdaptiveShell.tsx",
    );
    const styles = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/AdaptiveShell/AdaptiveShell.module.css",
    );

    expect(component).toContain('data-slot="adaptive-shell-scrim"');
    expect(styles).toContain("will-change: opacity");
    expect(styles).toContain("transform: translateZ(0)");
    expect(styles).toContain("backface-visibility: hidden");
    expect(styles).toContain("contain: layout paint style");
    expect(styles).toContain("-webkit-tap-highlight-color: transparent");
  });

  test("uses one edge-to-edge compact frame and browser chrome metadata", () => {
    const index = read("packages/butler-app/client/ui/index.html");
    const shell = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/AdaptiveShell/AdaptiveShell.module.css",
    );
    const prompt = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/PromptSuggestionList/PromptSuggestionList.module.css",
    );

    expect(index).toContain("viewport-fit=cover");
    expect(index).toContain('name="theme-color"');
    expect(shell).toContain("--app-window-radius: 0px");
    expect(shell).toContain("border: 0");
    expect(shell).toContain("contain: paint");
    expect(prompt).toContain("padding-block-start: var(--space-md)");
  });

  test("pushes the compact workspace and uses comfortable sidebar density", () => {
    const shell = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/AdaptiveShell/AdaptiveShell.module.css",
    );
    const navRow = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/NavRow/NavRow.module.css",
    );
    const tokens = read(
      "packages/butler-app/client/ui/src/libs/design-system/tokens.css",
    );

    expect(shell).toContain(
      "transform: translateX(var(--adaptive-drawer-width))",
    );
    expect(shell).toContain('.root[data-left-open="true"] .workspace');
    expect(tokens).toContain("--sidebar-row-height: 48px");
    expect(tokens).toContain("--sidebar-icon-size: 22px");
    expect(navRow).toContain("var(--sidebar-icon-size, 17px)");
    expect(navRow).toContain("font-size: var(--font-size-4)");
  });

  test("provides animated mobile composer idle and engaged states", () => {
    const composer = read(
      "packages/butler-app/client/ui/src/components/conversation/Composer.tsx",
    );
    const textArea = read(
      "packages/butler-app/client/ui/src/components/conversation/ComposerTextArea.tsx",
    );
    const card = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/ComposerCard/ComposerCard.tsx",
    );
    const styles = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/ComposerCard/ComposerCard.module.css",
    );
    const toolbar = read(
      "packages/butler-app/client/ui/src/components/conversation/ComposerToolbar.tsx",
    );
    const tokens = read(
      "packages/butler-app/client/ui/src/libs/design-system/tokens.css",
    );

    expect(composer).toContain("useComposerPresentation");
    expect(composer).toContain(
      "onPointerDownCapture={presentation.onPointerDownCapture}",
    );
    const presentation = read(
      "packages/butler-app/client/ui/src/components/conversation/hooks/useComposerPresentation.ts",
    );
    expect(presentation).toContain("internalPointerActive.current = true");
    expect(presentation).toContain("!internalPointerActive.current");
    expect(presentation).toContain("window.requestAnimationFrame");
    expect(presentation).toContain('"pointercancel", cancelInternalPointer');
    expect(composer).toContain("onFocusCapture");
    expect(composer).toContain("onBlurCapture");
    expect(textArea).toContain("const minRows = 1");
    expect(card).toContain("data-expanded={expanded}");
    expect(card).toContain("ComposerCardCompactPreview");
    expect(card).toContain("ComposerCardExpandedBody");
    expect(styles).toContain('.card[data-expanded="false"]');
    expect(styles).toContain("text-overflow: ellipsis");
    expect(styles).toContain("grid-template-rows: 0fr");
    expect(styles).toContain("border-radius: var(--adaptive-composer-radius)");
    expect(styles).not.toContain(
      '.card[data-expanded="false"] {\n    border-radius: var(--radius-pill)',
    );
    expect(styles).not.toContain(
      "border-radius var(--adaptive-panel-duration)",
    );
    expect(tokens).toContain("--adaptive-composer-radius: calc(");
    expect(tokens).toContain(
      "(var(--control-hit-target) + var(--space-md)) / 2",
    );
    expect(toolbar).toContain("<ComposerCardExpandedControls>");
    expect(toolbar).toContain("<ComposerSendButton");
  });

  test("removes compact fluid radius and duplicate sidebar reserve", () => {
    const prompt = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/PromptSuggestionList/PromptSuggestionList.module.css",
    );
    const sidebar = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/SidebarShell/SidebarShell.module.css",
    );
    expect(prompt).toContain(".fluidBackground {\n    border-radius: 0;");
    expect(sidebar).toContain(
      "padding: max(var(--safe-area-top), var(--space-sm))",
    );
    expect(sidebar).toContain(".titlebar {\n    display: none;");
  });

  test("enlarges the compact shell toggle and omits titlebar new chat", () => {
    const titlebar = read(
      "packages/butler-app/client/ui/src/components/layout/Titlebar.tsx",
    );
    const chrome = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/ChromeFrame/ChromeFrame.module.css",
    );
    const tokens = read(
      "packages/butler-app/client/ui/src/libs/design-system/tokens.css",
    );
    const titlebarShell = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/TitlebarShell/TitlebarShell.module.css",
    );

    expect(titlebar).not.toContain("titlebar-new-chat-button");
    expect(tokens).toContain("--chrome-floating-toggle-size: 52px");
    expect(tokens).toContain("--chrome-floating-toggle-icon-size: 22px");
    expect(tokens).toContain("--titlebar-action-size: 52px");
    expect(tokens).toContain("--titlebar-action-icon-size: 22px");
    expect(tokens).toContain(
      "(var(--titlebar-height) - var(--chrome-floating-toggle-size)) / 2",
    );
    expect(chrome).toContain("var(--chrome-floating-toggle-size, 30px)");
    expect(titlebarShell).toContain(
      "var(--chrome-floating-toggle-size, var(--control-hit-target))",
    );
    expect(titlebarShell).toContain("var(--titlebar-action-size, 30px)");
  });

  test("uses compact project-session tap and cancellable long press", () => {
    const item = read(
      "packages/butler-app/client/ui/src/components/layout/SidebarProjectSessionItem.tsx",
    );
    const gesture = read(
      "packages/butler-app/client/ui/src/components/layout/useLongPressAction.ts",
    );
    const navStyles = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/NavRow/NavRow.module.css",
    );

    expect(item).toContain("onClick={() => openSession(session.id)}");
    expect(item).toContain('rightVisibility="hover-compact-hidden"');
    expect(item).toContain("useLongPressAction(() => setMenuOpen(true))");
    expect(gesture).toContain("LONG_PRESS_DURATION_MS = 500");
    expect(gesture).toContain("LONG_PRESS_MOVE_TOLERANCE_PX = 10");
    expect(gesture).toContain("completedRef.current = true");
    expect(gesture).toContain("event.stopPropagation()");
    expect(navStyles).toContain(".compactHiddenActions");
    expect(navStyles).toContain("visibility: hidden");
    expect(item).toContain('WebkitTouchCallout: "none"');
    expect(item).toContain('userSelect: "none"');
  });
});
