// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import {
  applyKanbanMove, insertionIndex, isNoopDrop, laneAtPoint, nextKeyboardTarget, type KanbanLaneBox,
} from "./kanbanDragModel";

const card = (id: string, left: number, top: number) => ({ id, left, top, width: 200, height: 60 });
// A wide grid lane (two cards per row) above a board of three list lanes.
const lanes: KanbanLaneBox[] = [
  { id: "wide", left: 0, top: 0, width: 660, height: 200, layout: "grid", items: [card("w1", 10, 40), card("w2", 220, 40), card("w3", 10, 110)] },
  { id: "a", left: 0, top: 300, width: 220, height: 300, layout: "list", items: [card("a1", 10, 340), card("a2", 10, 410)] },
  { id: "b", left: 230, top: 300, width: 220, height: 300, layout: "list", items: [] },
  { id: "c", left: 460, top: 300, width: 220, height: 300, layout: "list", items: [card("c1", 470, 340)] },
];
const all = () => true;

test("a list lane inserts above the first card whose middle is below the pointer", () => {
  expect([330, 371, 380, 441, 590].map((y) => insertionIndex(lanes[1]!, 100, y))).toEqual([0, 1, 1, 2, 2]);
});

test("a grid lane inserts in reading order: rows above, then cards left of the pointer", () => {
  expect(insertionIndex(lanes[0]!, 50, 60)).toBe(0);
  expect(insertionIndex(lanes[0]!, 150, 60)).toBe(1);
  expect(insertionIndex(lanes[0]!, 300, 130)).toBe(3);
});

test("the target lane keeps its slot as slack below its measured bottom", () => {
  expect(laneAtPoint(lanes, 100, 650, null, 70)).toBeNull();
  expect(laneAtPoint(lanes, 100, 650, "a", 70)?.id).toBe("a");
  expect(laneAtPoint(lanes, 225, 400, null, 0)).toBeNull();
});

test("dropping a card above the card that already follows it changes nothing", () => {
  expect(isNoopDrop(["a1", "a2"], "a1", "a", { laneId: "a", beforeItemId: "a2" })).toBe(true);
  expect(isNoopDrop(["a1", "a2"], "a2", "a", { laneId: "a", beforeItemId: null })).toBe(true);
  expect(isNoopDrop(["a1", "a2"], "a2", "a", { laneId: "a", beforeItemId: "a1" })).toBe(false);
  expect(isNoopDrop(["a1", "a2"], "a1", "a", { laneId: "b", beforeItemId: null })).toBe(false);
});

test("keyboard steps through a lane, across the row and up into the board above", () => {
  expect(nextKeyboardTarget(lanes, { laneId: "a", beforeItemId: "a1" }, "down", all)).toEqual({ laneId: "a", beforeItemId: "a2" });
  expect(nextKeyboardTarget(lanes, { laneId: "a", beforeItemId: "a2" }, "right", all)).toEqual({ laneId: "b", beforeItemId: null });
  expect(nextKeyboardTarget(lanes, { laneId: "a", beforeItemId: "a2" }, "right", (id) => id !== "b")).toEqual({ laneId: "c", beforeItemId: null });
  expect(nextKeyboardTarget(lanes, { laneId: "a", beforeItemId: "a1" }, "up", all)).toEqual({ laneId: "wide", beforeItemId: null });
  expect(nextKeyboardTarget(lanes, { laneId: "wide", beforeItemId: "w2" }, "left", all)).toEqual({ laneId: "wide", beforeItemId: "w1" });
  expect(nextKeyboardTarget(lanes, { laneId: "wide", beforeItemId: "w1" }, "down", all)?.laneId).toBe("b");
  expect(nextKeyboardTarget(lanes, { laneId: "a", beforeItemId: "a1" }, "left", all)).toBeNull();
});

test("applyKanbanMove reorders within a lane and moves between lanes", () => {
  const state = { a: ["x", "y", "z"], b: ["q"] };
  expect(applyKanbanMove(state, { itemId: "z", fromLaneId: "a", toLaneId: "a", beforeItemId: "x" })).toEqual({ a: ["z", "x", "y"], b: ["q"] });
  expect(applyKanbanMove(state, { itemId: "x", fromLaneId: "a", toLaneId: "b", beforeItemId: null })).toEqual({ a: ["y", "z"], b: ["q", "x"] });
  expect(state).toEqual({ a: ["x", "y", "z"], b: ["q"] });
});
