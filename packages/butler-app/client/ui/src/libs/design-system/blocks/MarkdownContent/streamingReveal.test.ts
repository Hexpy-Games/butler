// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  STREAM_REVEAL_WINDOW_MS,
  revealStreamChunks,
  trackStreamChunks,
  type HastNode,
  type StreamChunk,
} from "./streamingReveal";

const css = readFileSync(new URL("./MarkdownContent.module.css", import.meta.url), "utf8");

function text(value: string, start: number, end = start + value.length): HastNode {
  return { type: "text", value, position: { start: { offset: start }, end: { offset: end } } };
}

function paragraph(...children: HastNode[]): HastNode {
  return { type: "element", tagName: "p", properties: {}, children };
}

test("chunk tracking records every appended chunk while the text keeps growing", () => {
  let state = trackStreamChunks({ text: "", chunks: [] }, "Hello", 1000);
  expect(state.chunks).toEqual([{ start: 0, at: 1000 }]);
  state = trackStreamChunks(state, "Hello world", 1050);
  expect(state.chunks).toEqual([{ start: 0, at: 1000 }, { start: 5, at: 1050 }]);
  state = trackStreamChunks(state, "Hello world", 1060);
  expect(state.chunks).toHaveLength(2);
  state = trackStreamChunks(state, "Hello world!", 1000 + STREAM_REVEAL_WINDOW_MS + 1);
  expect(state.chunks.map((chunk) => chunk.start)).toEqual([0, 5, 11]);
  expect(trackStreamChunks(state, "Different", 2000).chunks).toEqual([]);
});

test("every chunk keeps its own span so React reuses it; only recent chunks fade", () => {
  const chunks: StreamChunk[] = [{ start: 0, at: 100 }, { start: 6, at: 900 }, { start: 12, at: 980 }];
  const tree: HastNode = { type: "root", children: [paragraph(text("Hello brave world", 0))] };
  revealStreamChunks(tree, chunks, 1000, "chunk");
  const children = tree.children![0]!.children!;
  expect(children).toHaveLength(3);
  // Settled chunk: a plain span, so later chunks never shift React keys.
  expect(children[0]).toMatchObject({ type: "element", tagName: "span", properties: {}, children: [{ value: "Hello " }] });
  expect(children[1]).toMatchObject({
    type: "element",
    tagName: "span",
    properties: { className: ["chunk"], style: "animation-delay:-100ms" },
    children: [{ type: "text", value: "brave " }],
  });
  expect(children[2]).toMatchObject({ properties: { style: "animation-delay:-20ms" }, children: [{ value: "world" }] });
});

test("text present before streaming was observed stays a plain text node", () => {
  const tree: HastNode = { type: "root", children: [paragraph(text("Earlier new", 0))] };
  revealStreamChunks(tree, [{ start: 8, at: 990 }], 1000, "chunk");
  const children = tree.children![0]!.children!;
  expect(children[0]).toMatchObject({ type: "text", value: "Earlier " });
  expect(children[1]).toMatchObject({ tagName: "span", children: [{ value: "new" }] });
});

test("text nodes that start inside a chunk are wrapped whole", () => {
  const tree: HastNode = { type: "root", children: [paragraph(text("abc", 0)), paragraph(text("def", 5))] };
  revealStreamChunks(tree, [{ start: 2, at: 990 }], 1000, "chunk");
  expect(tree.children![0]!.children!.map((child) => child.type)).toEqual(["text", "element"]);
  expect(tree.children![1]!.children![0]).toMatchObject({ tagName: "span", children: [{ value: "def" }] });
});

test("code blocks and nodes without source positions are left alone", () => {
  const code: HastNode = { type: "element", tagName: "pre", properties: {}, children: [text("let a = 1", 0)] };
  const loose: HastNode = { type: "text", value: "loose" };
  const tree: HastNode = { type: "root", children: [code, paragraph(loose)] };
  revealStreamChunks(tree, [{ start: 0, at: 1000 }], 1000, "chunk");
  expect(code.children![0]!.type).toBe("text");
  expect(tree.children![1]!.children![0]!.type).toBe("text");
});

test("the chunk fade is opacity-only on the base duration", () => {
  expect(css).toMatch(/\.streamChunk \{\s*animation: markdown-stream-chunk var\(--motion-base\)\s+var\(--motion-ease-standard\) both;/u);
  const keyframes = css.slice(css.indexOf("@keyframes markdown-stream-chunk"));
  expect(keyframes).toMatch(/from \{\s*opacity: 0;\s*\}/u);
  expect(keyframes.slice(0, keyframes.indexOf("}\n}"))).not.toContain("transform");
});
