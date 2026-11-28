// test-category: pure-logic
import { afterEach, beforeEach, expect, test } from "bun:test";
import { InputQueue, textDiff } from "./input";

const raf = globalThis.requestAnimationFrame;
let frame: () => void;
beforeEach(() => {
  globalThis.requestAnimationFrame = callback => {
    frame = () => callback(0);
    return 1;
  };
});
afterEach(() => {
  globalThis.requestAnimationFrame = raf;
});

test("coalesces move and wheel events and caps concatenated text at 256 characters", () => {
  const sent: unknown[] = [];
  const queue = new InputQueue(async batch => { sent.push(batch.events); });
  queue.push(
    { t: "move", x: 0.25, y: 0.25 }, { t: "move", x: 0.5, y: 0.5 },
    { t: "wheel", x: 0.25, y: 0.25, dx: 0.5, dy: -0.5 },
    { t: "wheel", x: 0.5, y: 0.5, dx: 0.25, dy: 0.25 },
    { t: "text", value: "a".repeat(255) }, { t: "text", value: "bc" },
  );
  frame();
  expect(sent).toEqual([[
    { t: "move", x: 0.5, y: 0.5 },
    { t: "wheel", x: 0.5, y: 0.5, dx: 0.75, dy: -0.25 },
    { t: "text", value: "a".repeat(255) + "b" },
    { t: "text", value: "c" },
  ]]);
});

test("reuses the sequence number on retry", async () => {
  const sequences: number[] = [];
  const { promise, resolve } = Promise.withResolvers<void>();
  const queue = new InputQueue(async batch => {
    sequences.push(batch.seq);
    if (sequences.length === 1) throw new TypeError("network");
    resolve();
  });
  queue.push({ t: "key", key: "Enter" });
  frame();
  await promise;
  expect(sequences).toEqual([1, 1]);
});

test("diffs Hangul composition and deletion", () => {
  expect(textDiff("ㅎ", "하")).toEqual({ backspaces: 1, insert: "하" });
  expect(textDiff("한글", "한")).toEqual({ backspaces: 1, insert: "" });
});
