/// <reference types="bun" />
import { expect, test } from "bun:test";
import { TAB_STRIP_LABELS, chipAccessibleLabel, tabAccessibleLabel } from "./tabStripLabels";
import {
  chipKey, focusAfterClose, moveTabByStep, moveTabOnDrop, nextFocusKey, stripItems, tabKey, type TabStripGroup,
} from "./tabStripModel";

const groups: TabStripGroup[] = [
  { id: "mine", kind: "mine", tabs: [{ id: "a1", title: "Docs" }, { id: "a2", title: "Mail" }] },
  { id: "c1", kind: "conversation", label: "Shopping", tabs: [{ id: "b1", title: "Cart" }, { id: "b2", title: "Search" }], state: "working" },
  { id: "c2", kind: "conversation", label: "Trip", collapsed: true, tabs: [{ id: "c1t", title: "Hotel" }] },
];

// test-category: pure-logic
test("strip items list chips then the tabs of open groups, in visual order", () => {
  expect(stripItems(groups).map((item) => item.key)).toEqual([
    chipKey("mine"), tabKey("a1"), tabKey("a2"), chipKey("c1"), tabKey("b1"), tabKey("b2"), chipKey("c2"),
  ]);
  expect(stripItems([groups[0]!]).map((item) => item.key)).toEqual([tabKey("a1"), tabKey("a2")]);
});

// test-category: pure-logic
test("hideChip drops the chip of a lone group of any kind, never beside other groups", () => {
  const lone = [groups[1]!];
  expect(stripItems(lone).map((item) => item.key)).toEqual([chipKey("c1"), tabKey("b1"), tabKey("b2")]);
  expect(stripItems(lone, true).map((item) => item.key)).toEqual([tabKey("b1"), tabKey("b2")]);
  expect(stripItems(groups, true).map((item) => item.key)).toEqual(stripItems(groups).map((item) => item.key));
});

// test-category: pure-logic
test("arrow keys wrap across groups and Home/End jump to the ends", () => {
  const items = stripItems(groups);
  expect(nextFocusKey(items, tabKey("a2"), "ArrowRight")).toBe(chipKey("c1"));
  expect(nextFocusKey(items, chipKey("c2"), "ArrowRight")).toBe(chipKey("mine"));
  expect(nextFocusKey(items, chipKey("mine"), "ArrowLeft")).toBe(chipKey("c2"));
  expect(nextFocusKey(items, tabKey("b1"), "Home")).toBe(chipKey("mine"));
  expect(nextFocusKey(items, tabKey("b1"), "End")).toBe(chipKey("c2"));
  expect(focusAfterClose(items, tabKey("b2"))).toBe(chipKey("c2"));
  expect(focusAfterClose(stripItems([groups[0]!]), tabKey("a2"))).toBe(tabKey("a1"));
});

// test-category: pure-logic
test("keyboard moves step within a group and cross into the neighbor group at its edge", () => {
  expect(moveTabByStep(groups, "a1", 1)).toEqual({ tabId: "a1", fromGroupId: "mine", toGroupId: "mine", index: 1 });
  expect(moveTabByStep(groups, "a2", 1)).toEqual({ tabId: "a2", fromGroupId: "mine", toGroupId: "c1", index: 0 });
  expect(moveTabByStep(groups, "b1", -1)).toEqual({ tabId: "b1", fromGroupId: "c1", toGroupId: "mine", index: 2 });
  expect(moveTabByStep(groups, "a1", -1)).toBeNull();
});

// test-category: pure-logic
test("a drop takes the slot of the tab it lands on, or joins a chip's group at the end", () => {
  expect(moveTabOnDrop(groups, "a1", tabKey("a2"))).toEqual({ tabId: "a1", fromGroupId: "mine", toGroupId: "mine", index: 1 });
  expect(moveTabOnDrop(groups, "a2", tabKey("b1"))).toEqual({ tabId: "a2", fromGroupId: "mine", toGroupId: "c1", index: 1 });
  expect(moveTabOnDrop(groups, "b2", tabKey("a2"))).toEqual({ tabId: "b2", fromGroupId: "c1", toGroupId: "mine", index: 1 });
  expect(moveTabOnDrop(groups, "a1", chipKey("c2"))).toEqual({ tabId: "a1", fromGroupId: "mine", toGroupId: "c2", index: 1 });
  expect(moveTabOnDrop(groups, "b2", chipKey("c1"))).toBeNull();
  expect(moveTabOnDrop(groups, "a1", tabKey("a1"))).toBeNull();
});

// test-category: format-pin
test("accessible names carry the title, count and state", () => {
  expect(tabAccessibleLabel({ id: "x", title: " ", state: "crashed" }, TAB_STRIP_LABELS)).toBe("Untitled, Page stopped");
  expect(chipAccessibleLabel(groups[1]!, TAB_STRIP_LABELS)).toBe("Shopping, 2 tabs, Butler is working");
  expect(chipAccessibleLabel(groups[0]!, TAB_STRIP_LABELS)).toBe("My tabs, 2 tabs");
});
