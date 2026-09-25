import { useMemo, useRef } from "react";
import styles from "./MarkdownContent.module.css";

/**
 * Streaming text reveal (DS spec Motion Contract). Every appended chunk of the
 * markdown source gets its own inline span while the message streams, so
 * React keeps reusing the same span for the same text (no moved text, no
 * layout shift); only recent chunks carry the fade class, and a span
 * re-created by a markdown restructure resumes through a negative
 * animation-delay. Settled messages render plain markdown.
 */

/** Chunks younger than this fade (fade duration + margin). */
export const STREAM_REVEAL_WINDOW_MS = 400;

export interface StreamChunk {
  /** Source offset where the chunk starts. */
  start: number;
  /** performance.now() when the chunk arrived. */
  at: number;
}

export interface StreamState {
  text: string;
  chunks: StreamChunk[];
}

export interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

export function trackStreamChunks(previous: StreamState, text: string, now: number): StreamState {
  if (text === previous.text) return previous;
  if (!text.startsWith(previous.text)) return { text, chunks: [] };
  return { text, chunks: [...previous.chunks, { start: previous.text.length, at: now }] };
}

const SKIPPED_ELEMENTS = new Set(["pre", "code", "script", "style"]);

function chunkSpan(value: string, chunk: StreamChunk, now: number, className: string): HastNode {
  const age = Math.max(0, Math.round(now - chunk.at));
  return {
    type: "element",
    tagName: "span",
    properties: age <= STREAM_REVEAL_WINDOW_MS ? { className: [className], style: `animation-delay:-${age}ms` } : {},
    children: [{ type: "text", value }],
  };
}

function splitText(node: HastNode, chunks: StreamChunk[], now: number, className: string): HastNode[] {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  const value = node.value ?? "";
  if (start === undefined || end === undefined || chunks.length === 0) return [node];
  const covering = [...chunks].reverse().find((chunk) => chunk.start <= start);
  // Escapes or trimmed whitespace break the source/value offset mapping.
  if (value.length !== end - start) {
    return covering ? [chunkSpan(value, covering, now, className)] : [node];
  }
  const cuts = chunks.filter((chunk) => chunk.start > start && chunk.start < end);
  if (!covering && cuts.length === 0) return [node];
  const parts: HastNode[] = [];
  let cursor = 0;
  let current = covering;
  for (const cut of [...cuts, null]) {
    const stop = cut ? cut.start - start : value.length;
    const piece = value.slice(cursor, stop);
    if (piece) parts.push(current ? chunkSpan(piece, current, now, className) : { type: "text", value: piece });
    if (cut) {
      cursor = stop;
      current = cut;
    }
  }
  return parts;
}

/** Wraps each chunk in a span (recent ones fade); mutates and returns the hast tree. */
export function revealStreamChunks(tree: HastNode, chunks: StreamChunk[], now: number, className: string): HastNode {
  const visit = (node: HastNode) => {
    if (!node.children || (node.type === "element" && SKIPPED_ELEMENTS.has(node.tagName ?? ""))) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return splitText(child, chunks, now, className);
      visit(child);
      return [child];
    });
  };
  visit(tree);
  return tree;
}

type RehypePlugin = () => (tree: HastNode) => void;

/**
 * Rehype plugin list for react-markdown while `active` (streaming); an empty
 * list otherwise, so settled messages render plain markdown.
 */
export function useStreamingReveal(text: string, active: boolean): RehypePlugin[] {
  const state = useRef<StreamState>({ text, chunks: [] });
  const now = typeof performance === "undefined" ? Date.now() : performance.now();
  // First render of a message shows its existing text without a fade.
  state.current = active ? trackStreamChunks(state.current, text, now) : { text, chunks: [] };
  const chunks = state.current.chunks;
  return useMemo(() => {
    if (!active || chunks.length === 0) return [];
    const plugin: RehypePlugin = () => (tree) => {
      revealStreamChunks(tree, chunks, now, styles.streamChunk);
    };
    return [plugin];
  }, [active, chunks, now]);
}
