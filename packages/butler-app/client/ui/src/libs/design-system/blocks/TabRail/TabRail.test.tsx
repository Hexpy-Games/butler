// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TabRail } from "./TabRail";
import { railColumn, splitRailTabs, tabRailCap, tabRailMode } from "./tabRailLayout";

test("the mode follows the container width: full from 960, compact from 720, shelf below", () => {
  expect([1440, 960, 959, 720, 719, 320].map(tabRailMode)).toEqual(["full", "full", "compact", "compact", "shelf", "shelf"]);
});

test("three cards, two in a container shorter than 600px, the rest behind +N", () => {
  expect(tabRailCap(900)).toBe(3);
  expect(tabRailCap(599)).toBe(2);
  expect(tabRailCap(400, 1)).toBe(1);
  expect(splitRailTabs(["a", "b", "c", "d", "e"], 3)).toEqual({ shown: ["a", "b", "c"], hidden: ["d", "e"] });
});

test("the column moves only as far as needed and keeps 24px clear of the rail", () => {
  // 1440 window with the sidebar open: the card is 1126 wide; the column moves 65px (plan §2).
  const wide = railColumn({ width: 1126, column: 760, rail: 208 });
  expect(wide).toEqual({ left: 118, width: 760, shift: 65 });
  expect(wide.left + wide.width).toBe(1126 - 16 - 208 - 24);
  // A very wide card needs no shift at all.
  expect(railColumn({ width: 1800, column: 760, rail: 208 }).shift).toBe(0);
  // A narrow compact card narrows the column instead of pushing it off the left edge.
  const narrow = railColumn({ width: 760, column: 660, rail: 128 });
  expect(narrow.left).toBe(24);
  expect(narrow.left + narrow.width).toBe(760 - 16 - 128 - 24);
});

test("a forced mode renders the region, cards and the +N pill with its label", () => {
  const tab = (id: string) => ({ id, title: `Tab ${id}`, onOpen: () => undefined, onClose: () => undefined });
  const markup = renderToStaticMarkup(
    <TabRail mode="full" tabs={["1", "2", "3", "4", "5"].map(tab)} onMore={() => undefined}
      labels={{ region: "Butler's tabs", close: "Close tab", more: (count) => `${count} more tabs` }} />,
  );
  expect(markup).toContain('aria-label="Butler&#x27;s tabs"');
  expect(markup.match(/data-slot="live-tab-card"/gu)?.length).toBe(3);
  expect(markup).toContain('aria-label="2 more tabs"');
  expect(markup).toContain("+2");
});
