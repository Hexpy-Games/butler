// test-category: pure-logic
import { expect, mock, test } from "bun:test";
import { createSelectableRows } from "./selectableRows";

test("commits visible rows only at rest and ignores reordered membership", () => {
  const rows = createSelectableRows();
  const listener = mock(() => {});
  rows.subscribe(listener);

  rows.begin();
  rows.onViewableItemsChanged({ viewableItems: [{ key: "a" }, { key: "b" }] });
  expect(rows.has("a")).toBe(false);
  expect(listener).not.toHaveBeenCalled();

  rows.settle();
  expect(rows.has("a")).toBe(true);
  expect(rows.has("b")).toBe(true);
  expect(listener).toHaveBeenCalledTimes(1);

  rows.onViewableItemsChanged({ viewableItems: [{ key: "b" }, { key: "a" }] });
  expect(listener).toHaveBeenCalledTimes(1);
  rows.onViewableItemsChanged({ viewableItems: [{ key: "c" }] });
  expect(rows.has("a")).toBe(false);
  expect(rows.has("c")).toBe(true);
});
