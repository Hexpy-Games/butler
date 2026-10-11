// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LibraryCard } from "../LibraryCard";
import { matchTags, tagKey } from "../TagField";
import { GroupTile, GroupTileMore } from "./GroupTile";

// Contracts the Library's organizing UI relies on (group tiles, card tags and selection, tag completion).
const tile = (count: number) => renderToStaticMarkup(
  <GroupTile name="Travel" meta={`${count} scraps`} emptyLabel="Empty" dropId="g1" onOpen={() => undefined}
    previews={Array.from({ length: count }, () => ({ kind: "document" as const }))} />,
);

test("GroupTile shows its newest four as a 1 · 2 · 3 · 2×2 mosaic and an empty folder at 0", () => {
  for (const count of [1, 2, 3, 4]) expect(tile(count)).toContain(`data-count="${count}"`);
  expect(tile(7)).toContain('data-count="4"');
  expect(tile(0)).toContain("Empty");
  expect(tile(0)).not.toContain("data-count");
  expect(tile(2)).toContain('data-group-tile="g1"');
});

test("GroupTile drop state rings the tile and shows the hint; the overflow tile says how many are left", () => {
  const drop = renderToStaticMarkup(<GroupTile name="Travel" previews={[]} emptyLabel="Empty" drop dropHint="Add to “Travel”" />);
  expect(drop).toContain("Add to “Travel”");
  expect(drop).toContain('data-drop="true"');
  expect(renderToStaticMarkup(<GroupTileMore count={3} label="3 more groups" meta="View all" />)).toContain("+3");
});

test("LibraryCard: two tags then +N, a selection checkbox, and the name field while renaming", () => {
  const card = renderToStaticMarkup(
    <LibraryCard media={{ kind: "document" }} title="Q3 report" tags={["a", "b", "c", "d"]} selectLabel="Select"
      onSelectedChange={() => undefined} selected selectionMode />,
  );
  expect(card).toContain(">a<");
  expect(card).toContain(">b<");
  expect(card).not.toContain(">c<");
  expect(card).toContain("+2");
  expect(card).toContain('role="checkbox"');
  expect(card).toContain('aria-checked="true"');
  const renaming = renderToStaticMarkup(
    <LibraryCard media={{ kind: "document" }} title="Q3 report" editing={{ value: "Q3 report", label: "Name", onCommit: () => undefined, onCancel: () => undefined }} />,
  );
  expect(renaming).toContain('aria-label="Name"');
  expect(renaming).toContain('value="Q3 report"');
  expect(renderToStaticMarkup(<LibraryCard media={{ kind: "document" }} title="x" />)).not.toContain("library-card-tags");
});

test("Tag completion: NFKC and case fold, prefix before contains, chosen tags left out", () => {
  expect(tagKey(" ＣＡＦＥ ")).toBe("cafe");
  const all = [{ name: "camping", count: 3 }, { name: "cafés", count: 14 }, { name: "pecan", count: 9 }, { name: "Café", count: 1 }];
  expect(matchTags("ca", all, []).map((t) => t.name)).toEqual(["cafés", "camping", "Café", "pecan"]);
  expect(matchTags("CA", all, ["cafés"]).map((t) => t.name)).toEqual(["camping", "Café", "pecan"]);
  expect(matchTags("  ", all, [])).toEqual([]);
});
