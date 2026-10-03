import type { ReactNode } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { AdaptiveBreakpoints, DropZoneDiagram, GlassOverContent, KoreanWrapping, SettingsRamp } from "./demos";

type AppLocale = ShowcaseRenderContext["locale"];

export interface PatternStoryRef {
  /** Showcase entry id, e.g. "blocks/FormSection". */
  entry: string;
  story: string;
}

export interface PatternDefinition {
  id: string;
  title: string;
  summary: string;
  rules: string[];
  /** Tokens the pattern is built on. */
  tokens: string[];
  /** Live stories reused from showcases (no copied fixtures). */
  live: PatternStoryRef[];
  demo?: (locale: AppLocale) => ReactNode;
}

export const PATTERNS: PatternDefinition[] = [
  {
    id: "composer-decorations",
    title: "Composer decorations",
    summary: "Background themes for ComposerCard.",
    rules: ["Keep the existing composer surface, input and controls."],
    tokens: ["--management-page-veil", "--adaptive-composer-radius", "--pulse-duration"],
    live: [],
  },
  {
    id: "tinted-glass",
    title: "Tinted glass",
    summary: "Floating surfaces (composer, popovers, tooltips, dialogs) are translucent glass over the conversation, tinted toward the theme so text stays readable.",
    rules: [
      "Only floating layers are glass; page content and cards stay opaque.",
      "Use TintedGlass or the DS overlay components; never hand-roll backdrop-filter.",
      "Glass keeps the hairline edge and shadow from --tinted-glass-* tokens in both themes.",
    ],
    tokens: ["--tinted-glass-bg", "--tinted-glass-tint", "--tinted-glass-filter", "--tinted-glass-shadow", "--composer-glass-bg"],
    live: [{ entry: "components/TintedGlass", story: "Composer surface" }, { entry: "components/TintedGlass", story: "Popover surface" }],
    demo: (locale) => <GlassOverContent locale={locale} />,
  },
  {
    id: "scroll-fade",
    title: "Scroll edge fade",
    summary: "Content clipped at a scroll edge fades out; the fade appears only on edges that still have content, so clipping reads as scroll affordance.",
    rules: [
      "Every scrollable area uses ScrollArea (or useScrollEdges + scroll-fade.css); never copy a mask.",
      "Fades react to scroll position: none at the top boundary, none at the bottom boundary.",
      "Keep enough edge padding that text never sits inside the fade at rest.",
    ],
    tokens: ["--scroll-fade-size"],
    live: [{ entry: "blocks/ScrollArea", story: "Vertical with edge fades" }, { entry: "blocks/SidebarShell", story: "Scrolling list with sticky filter" }],
  },
  {
    id: "adaptive-shell",
    title: "Adaptive shell and breakpoints",
    summary: "One shell adapts from phone to desktop: side panels are drawers over a scrim on compact widths and columns beside the workspace when there is room.",
    rules: [
      "Compose screens inside AdaptiveShell; never add viewport media queries in product CSS.",
      "Phones (≤ 640px) and coarse pointers get 44px touch targets and the touch sidebar density.",
      "Check 320, 375, 430, app and wide in the toolbar before shipping a screen.",
    ],
    tokens: ["--adaptive-drawer-width", "--adaptive-inspector-width", "--adaptive-panel-duration", "--control-hit-target", "--touch-target"],
    live: [{ entry: "blocks/AdaptiveShell", story: "Sidebar, workspace and inspector" }],
    demo: () => <AdaptiveBreakpoints />,
  },
  {
    id: "korean-typography",
    title: "Korean typography",
    summary: "Korean wraps between words (keep-all), never inside one; long unbroken tokens such as paths and URLs still wrap instead of overflowing.",
    rules: [
      "Set lang on the root (or on a Korean subtree); :lang(ko) applies word-break: keep-all and overflow-wrap.",
      "Never add word-break overrides per component; write copy that fits instead.",
      "Check every screen in KO: labels are often longer and particles attach to words.",
    ],
    tokens: ["--font-body", "--typo-body-size", "--line-height-body"],
    live: [{ entry: "blocks/QueuedMessage", story: "Long unbroken token" }],
    demo: () => <KoreanWrapping />,
  },
  {
    id: "settings-layout",
    title: "Settings layout",
    summary: "A settings page is a column of sections: the section header sits above its card (outside the surface), fields inside the card follow one spacing ramp.",
    rules: [
      "Header to card is tight (--settings-section-header-gap); card to the next header is far (--settings-section-gap).",
      "Inside a card: label → description (copy gap), description → control, field → field.",
      "A section header that only repeats the page title is dropped.",
    ],
    tokens: ["--settings-section-header-gap", "--settings-section-gap", "--settings-section-padding", "--settings-field-gap", "--settings-field-copy-gap", "--settings-field-control-gap"],
    live: [{ entry: "blocks/FormSection", story: "Stacked sections (header belongs to the card below)" }, { entry: "blocks/SettingsShell", story: "Start-aligned page (narrow PageContainer)" }],
    demo: () => <SettingsRamp />,
  },
  {
    id: "drag-drop",
    title: "Drag and drop feedback",
    summary: "Dragging opens a one-row slot where the item lands (insert) or rings the target (group); drop zones are measured on layout boxes so feedback never moves them.",
    rules: [
      "Rows are 25% before, 50% group or inside, 25% after; rows that cannot combine split 50/50.",
      "Hysteresis (4px) and a 150ms dwell before group keep the zone from flickering.",
      "Use NavDropScope, NavDropTarget and CollapsibleList; reduced motion shows the line without moving rows.",
    ],
    tokens: ["--motion-scale-lift", "--shadow-drag-lift", "--drop-clip-margin", "--z-drop-indicator"],
    live: [{ entry: "blocks/NavDropTarget", story: "Drag and drop (interactive)" }, { entry: "blocks/SortableCardList", story: "Reorder with lift" }],
    demo: () => <DropZoneDiagram />,
  },
  {
    id: "queued-message",
    title: "Queued messages",
    summary: "Follow-ups sent while a turn runs appear in the conversation as dashed user bubbles, in order, and resolve into the real message when delivered.",
    rules: [
      "The conversation is the only queue surface; the composer does not list queued messages.",
      "Show position when several wait; failed sends stay in place with retry and delete.",
      "Delivery resolves the bubble in place; a fresh send flies from the composer.",
    ],
    tokens: ["--user-message-bg", "--border-hairline", "--motion-slow"],
    live: [{ entry: "blocks/QueuedMessage", story: "Several with positions" }, { entry: "blocks/QueuedMessage", story: "Delivery" }, { entry: "blocks/QueuedMessage", story: "Failed" }],
  },
];

export const PATTERN_IDS = PATTERNS.map((pattern) => pattern.id);
