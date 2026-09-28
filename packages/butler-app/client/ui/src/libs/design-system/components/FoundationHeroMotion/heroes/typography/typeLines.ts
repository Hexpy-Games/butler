import type { Box } from "../../heroTimeline";
import { fontBox, graphemeEdges } from "./specimenMetrics";
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
  /** Wrapped paragraphs reveal their rows instead of drawing glyph by glyph. */
  draw: boolean;
  /** Secondary text (values, second fields): revealed left to right, without a tag or guides. */
  secondary?: boolean;
}

const own = (id: string) => `[data-line="${id}"]`;
const firstMetric = (slot: string) => `[data-panel="metric"] [data-slot="${slot}"]:not([data-t="metric-2"] *)`;
const secondMetric = (slot: string) => `[data-t="metric-2"] [data-slot="${slot}"]`;

/** The text lines each component builds, in cascade order. */
export const LINES: LineSpec[] = [
  { id: "title", panel: "settings", token: "--typo-h2", role: "heading", select: own("title"), draw: true },
  { id: "lead", panel: "settings", token: "--typo-body", role: "body", select: own("lead"), draw: true },
  { id: "field", panel: "settings", token: "--typo-label", role: "label", select: own("field"), draw: true },
  { id: "hint", panel: "settings", token: "--typo-caption", role: "caption", select: own("hint"), draw: true },
  { id: "field2", panel: "settings", token: "--typo-label", role: "label", select: own("field2"), draw: true, secondary: true },
  { id: "hint2", panel: "settings", token: "--typo-caption", role: "caption", select: own("hint2"), draw: true, secondary: true },
  { id: "ask", panel: "chat", token: "--typo-body", role: "body", select: own("ask"), draw: true },
  { id: "answer", panel: "chat", token: "--typo-body", role: "body", select: own("answer"), draw: false },
  { id: "command", panel: "chat", token: "--typo-code", role: "code", select: own("command"), draw: true },
  { id: "worked", panel: "chat", token: "--font-size-2", role: "caption", select: own("worked"), draw: true, secondary: true },
  { id: "meta", panel: "chat", token: "--font-size-2", role: "caption", select: own("meta"), draw: true },
  { id: "done", panel: "chat", token: "--typo-caption", role: "caption", select: own("done"), draw: true, secondary: true },
  { id: "dash", panel: "metric", token: "--typo-dashboard-title", role: "dashboard", select: own("dash"), draw: true },
  { id: "value", panel: "metric", token: "--typo-metric-value", role: "metric", select: firstMetric("metric-value"), draw: true },
  { id: "label", panel: "metric", token: "--typo-caption", role: "caption", select: firstMetric("metric-label"), draw: true },
  { id: "change", panel: "metric", token: "--typo-caption", role: "caption", select: `${firstMetric("metric-label")} + *`, draw: true, secondary: true },
  { id: "value2", panel: "metric", token: "--typo-metric-value", role: "metric", select: secondMetric("metric-value"), draw: true, secondary: true },
  { id: "label2", panel: "metric", token: "--typo-caption", role: "caption", select: secondMetric("metric-label"), draw: true, secondary: true },
  { id: "change2", panel: "metric", token: "--typo-caption", role: "caption", select: `${secondMetric("metric-label")} + *`, draw: true, secondary: true },
  { id: "placeholder", panel: "composer", token: "--typo-body", role: "body", select: own("placeholder"), draw: true },
];

/** Width of the badge gutter left of a component while it builds (badge column plus a grid gutter), in canvas px. */
export const BADGE_GUTTER = { wide: 320, tall: 150 } as const;

/**
 * Non-text parts of each component (controls, icons, a second card) and the
 * text line each belongs to, with the beat offset from that line's start: a
 * part appears in step with its own text.
 */
export const STRUCTURE: Record<Panel, Array<[part: string, line: string, offset: number]>> = {
  settings: [["switch", "field", 0.8], ["switch-2", "field2", 0.6]],
  chat: [["code-copy", "command", 0.6], ["chat-icons", "worked", 0], ["done-mark", "done", 0]],
  metric: [["metric-2", "value2", -0.4]],
  composer: [["more", "placeholder", 0], ["send", "placeholder", 1.6]],
};

/** A line as measured on the poster: box relative to its panel, font and baseline. */
export interface LineInfo extends LineSpec {
  box: Box;
  text: string;
  font: { family: string; size: number; weight: string; color: string; lineHeight: number; tracking: string };
  /** Baseline from the top of the line box. */
  baseline: number;
  /** Right edge of each grapheme (px from the line start), for the left-to-right reveal. */
  edges: number[];
  /** Drawn as an outline first (weights of 500 and up; lighter strokes reveal filled). */
  outlined: boolean;
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
      outlined: spec.draw && !spec.secondary && Number.parseFloat(style.fontWeight) >= 500,
      edges: spec.draw ? graphemeEdges(`${style.fontWeight} ${size}px ${style.fontFamily}`, (node.textContent ?? "").trim()) : [],
    });
  }
  return out;
}
