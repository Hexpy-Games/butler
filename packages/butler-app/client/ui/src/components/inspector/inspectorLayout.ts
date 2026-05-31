import type { CSSProperties } from "react";

const inspectorInlinePadding = "var(--inspector-inline-padding, 18px)";

export const inspectorInset = {
  marginInline: inspectorInlinePadding,
  width: `calc(100% - ${inspectorInlinePadding} - ${inspectorInlinePadding})`,
} as CSSProperties;

export const contextSectionInset = {
  paddingInline: inspectorInlinePadding,
} as CSSProperties;

export const contextLegendFrame = {
  "--scroll-area-frame-width": `calc(100% + ${inspectorInlinePadding})`,
  "--scroll-area-content-width": "100%",
  "--scroll-area-scrollbar-offset": "18px",
  "--scroll-area-fade-size": "10px",
  "--scroll-area-edge-padding": "var(--space-xs)",
  minHeight: "96px",
} as CSSProperties;

export const contextLegendContent = {
  paddingInlineEnd: inspectorInlinePadding,
} as CSSProperties;
