// test-category: pure-logic
/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { spanPieces } from "./spanGeometry";

const round = (pieces: ReturnType<typeof spanPieces<string>>) =>
  pieces.map((piece) => ({ ...piece, start: Number(piece.start.toFixed(4)), width: Number(piece.width.toFixed(4)) }));

describe("spanPieces", () => {
  test("fills the parent's uncovered time in its own tone around the children", () => {
    expect(round(spanPieces(0, 100, "agent", [
      { offset: 20, duration: 30, tone: "model" },
      { offset: 60, duration: 10, tone: "tool" },
    ]))).toEqual([
      { start: 0, width: 0.2, tone: "agent", hatch: false },
      { start: 0.2, width: 0.3, tone: "model", hatch: false },
      { start: 0.5, width: 0.1, tone: "agent", hatch: false },
      { start: 0.6, width: 0.1, tone: "tool", hatch: true },
      { start: 0.7, width: 0.3, tone: "agent", hatch: false },
    ]);
  });

  test("alternates solid and hatch over children in time order, whatever the input order", () => {
    const pieces = spanPieces(0, 40, "agent", [
      { offset: 30, duration: 10, tone: "wait" },
      { offset: 0, duration: 10, tone: "error" },
      { offset: 10, duration: 10, tone: "error" },
      { offset: 20, duration: 10, tone: "model" },
    ]);
    expect(pieces.map((piece) => [piece.tone, piece.hatch])).toEqual([
      ["error", false], ["error", true], ["model", false], ["wait", true],
    ]);
  });

  test("clips children to the parent and cuts overlaps at the earlier child's end", () => {
    expect(round(spanPieces(10, 20, "agent", [
      { offset: 0, duration: 15, tone: "model" },
      { offset: 12, duration: 6, tone: "tool" },
      { offset: 25, duration: 50, tone: "wait" },
    ]))).toEqual([
      { start: 0, width: 0.25, tone: "model", hatch: false },
      { start: 0.25, width: 0.15, tone: "tool", hatch: true },
      { start: 0.4, width: 0.35, tone: "agent", hatch: false },
      { start: 0.75, width: 0.25, tone: "wait", hatch: false },
    ]);
  });

  test("skips children outside the parent so the alternation counts only drawn children", () => {
    const pieces = spanPieces(0, 10, "agent", [
      { offset: 50, duration: 5, tone: "error" },
      { offset: 0, duration: 5, tone: "model" },
      { offset: 5, duration: 5, tone: "tool" },
    ]);
    expect(pieces.map((piece) => [piece.tone, piece.hatch])).toEqual([["model", false], ["tool", true]]);
  });

  test("draws nothing for an empty or invalid parent or no children", () => {
    expect(spanPieces(0, 0, "agent", [{ offset: 0, duration: 5, tone: "model" }])).toEqual([]);
    expect(spanPieces(0, Number.NaN, "agent", [{ offset: 0, duration: 5, tone: "model" }])).toEqual([]);
    expect(spanPieces(0, 10, "agent", [])).toEqual([]);
  });

  test("ignores children with non-finite or non-positive lengths (no drawn child: no pieces)", () => {
    expect(spanPieces(0, 10, "agent", [
      { offset: 2, duration: 0, tone: "model" },
      { offset: Number.NaN, duration: 3, tone: "tool" },
    ])).toEqual([]);
  });
});
