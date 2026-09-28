import type { Box } from "../../heroTimeline";
import { fontBox } from "./specimenMetrics";
import type { Panel } from "./typeChoreography";

/** Role words on the badges (translated); the token names never translate. */
export type LineRole = "heading" | "body" | "label" | "caption" | "code" | "dashboard" | "metric";

export interface LineSpec {
  id: string;
  panel: Panel;
  /** The typography token family the line is set in. */
  token: string;
  role: LineRole;
  /** Where the real text is: our own wrapper, or a slot inside a DS block. */
  select: string;
  /** Wrapped paragraphs fade in under their badge instead of drawing an outline. */
  draw: boolean;
}

const own = (id: string) => `[data-line="${id}"]`;
const firstMetric = (slot: string) => `[data-panel="metric"] [data-slot="${slot}"]:not([data-t="metric-2"] *)`;

/** The text lines each component builds, in cascade order. */
export const LINES: LineSpec[] = [
  { id: "title", panel: "settings", token: "--typo-h2", role: "heading", select: own("title"), draw: true },
  { id: "lead", panel: "settings", token: "--typo-body", role: "body", select: own("lead"), draw: true },
  { id: "field", panel: "settings", token: "--typo-label", role: "label", select: own("field"), draw: true },
  { id: "hint", panel: "settings", token: "--typo-caption", role: "caption", select: own("hint"), draw: true },
  { id: "ask", panel: "chat", token: "--typo-body", role: "body", select: own("ask"), draw: true },
  { id: "answer", panel: "chat", token: "--typo-body", role: "body", select: own("answer"), draw: false },
  { id: "command", panel: "chat", token: "--typo-code", role: "code", select: own("command"), draw: true },
  { id: "meta", panel: "chat", token: "--typo-caption", role: "caption", select: own("meta"), draw: true },
  { id: "dash", panel: "metric", token: "--typo-dashboard-title", role: "dashboard", select: own("dash"), draw: true },
  { id: "value", panel: "metric", token: "--typo-metric-value", role: "metric", select: firstMetric("metric-value"), draw: true },
  { id: "label", panel: "metric", token: "--typo-caption", role: "caption", select: firstMetric("metric-label"), draw: true },
  { id: "placeholder", panel: "composer", token: "--typo-body", role: "body", select: own("placeholder"), draw: true },
];

/** Width of the badge gutter left of a component while it builds (badge column plus a grid gutter), in canvas px. */
export const BADGE_GUTTER = { wide: 320, tall: 190 } as const;

/** Non-text structure each component builds before its text. */
export const STRUCTURE: Record<Panel, string[]> = { settings: ["switch", "field-2"], chat: [], metric: ["metric-2"], composer: ["send"] };

/** A line as measured on the poster: box relative to its panel, font and baseline. */
export interface LineInfo extends LineSpec {
  box: Box;
  text: string;
  font: { family: string; size: number; weight: string; color: string; lineHeight: number; tracking: string };
  /** Baseline from the top of the line box. */
  baseline: number;
}

/** Measures every line inside its panel (canvas px); null if a line is missing. */
export function measureLines(root: HTMLElement, ratio: number): LineInfo[] | null {
  const out: LineInfo[] = [];
  for (const spec of LINES) {
    const node = root.querySelector<HTMLElement>(spec.select);
    const panel = root.querySelector<HTMLElement>(`[data-panel="${spec.panel}"]`);
    if (!node || !panel) return null;
    const rect = node.getBoundingClientRect();
    const base = panel.getBoundingClientRect();
    const style = getComputedStyle(node);
    const size = Number.parseFloat(style.fontSize) || 14;
    const box = { x: (rect.left - base.left) / ratio, y: (rect.top - base.top) / ratio, w: rect.width / ratio, h: rect.height / ratio };
    const { ascent, descent } = fontBox(`${style.fontWeight} ${size}px ${style.fontFamily}`, node.textContent ?? "") ?? { ascent: size * 0.95, descent: size * 0.25 };
    const line = Number.parseFloat(style.lineHeight) || size * 1.4;
    out.push({
      ...spec, box, text: (node.textContent ?? "").trim(),
      font: { family: style.fontFamily, size, weight: style.fontWeight, color: style.color, lineHeight: line, tracking: style.letterSpacing === "normal" ? "0em" : style.letterSpacing },
      baseline: spec.draw ? (Math.min(line, box.h) - (ascent + descent)) / 2 + ascent : 0,
    });
  }
  return out;
}
