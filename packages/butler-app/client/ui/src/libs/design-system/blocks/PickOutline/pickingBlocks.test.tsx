// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageSquarePlus, Scrap } from "../../components/Icons";
import { DragPreview } from "../DragPreview";
import { ElementChip } from "../ElementChip";
import { LibraryCard, libraryImageFit } from "../LibraryCard";
import { SelectionBar, type SelectionBarAction } from "../SelectionBar";
import { PickOutline } from "./PickOutline";

// Contracts the browser's pick and drag flow relies on (S5 DS gaps).
const ACTIONS: SelectionBarAction[] = [
  { id: "attach", label: "Add to chat", icon: <MessageSquarePlus size="sm" />, onSelect: () => undefined },
  { id: "scrap", label: "Scrap", icon: <Scrap size="sm" />, onSelect: () => undefined },
];

function bar(count: number, extra: Partial<Parameters<typeof SelectionBar>[0]> = {}) {
  return renderToStaticMarkup(
    <SelectionBar count={count} label={`${count} selected`} hint="Click an element to pick it" emptyReason="Pick an element first"
      actions={ACTIONS} onClear={() => undefined} clearLabel="Clear" {...extra} />,
  );
}

test("SelectionBar at 0 is the picking state: hint as name, actions present but unavailable, no Clear", () => {
  const markup = bar(0);
  expect(markup).toContain('data-empty="true"');
  expect(markup).toContain('aria-label="Click an element to pick it"');
  expect(markup).toContain("Add to chat");
  expect(markup.match(/aria-disabled="true"/gu)?.length).toBe(4); // two worded + two icon-only actions
  expect(markup).toContain('aria-label="Add to chat · Pick an element first"');
  expect(markup).not.toContain('aria-label="Clear"');
});

test("SelectionBar with picks keeps actions available and Clear last", () => {
  const markup = bar(2);
  expect(markup).not.toContain("aria-disabled");
  expect(markup).toContain('aria-label="2 selected"');
  expect(markup.lastIndexOf('aria-label="Clear"')).toBeGreaterThan(markup.lastIndexOf("Scrap"));
});

test("SelectionBar: one action can be unavailable on its own; a compact pill at 0 renders nothing", () => {
  const markup = bar(2, { actions: [ACTIONS[0]!, { ...ACTIONS[1]!, disabledReason: "Already scrapped" }] });
  expect(markup.match(/aria-disabled="true"/gu)?.length).toBe(2);
  expect(markup).toContain('aria-label="Scrap · Already scrapped"');
  expect(bar(0, { compact: true })).toBe("");
});

test("PickOutline numbers picks in order and keeps badges inside the layer", () => {
  const markup = renderToStaticMarkup(
    <PickOutline width={400} height={300} hover={{ x: 200, y: 4, width: 120, height: 80 }} hoverLabel="div.card · 120 × 80"
      picks={[{ id: "a", rect: { x: 0, y: 0, width: 100, height: 100 } }, { id: "b", rect: { x: 150, y: 150, width: 80, height: 80 } }]} reducedMotion />,
  );
  expect(markup).toContain('data-reduced="true"');
  expect(markup.match(/data-pick-outline="picked"/gu)?.length).toBe(2);
  expect(markup).toMatch(/data-pick-badge="">1</u);
  expect(markup).toMatch(/data-pick-badge="">2</u);
  expect(markup).toContain("translate:11px 11px"); // the first pick's badge clamped inside the layer
  expect(markup).toContain('data-tag-below="true"'); // no room above the hover outline at the top edge
  expect(markup).toContain("div.card · 120 × 80");
});

test("DragPreview floats at the pointer when given `at`, and renders static without it", () => {
  const floating = renderToStaticMarkup(<DragPreview kind="elements" images={[{ src: "a.png" }]} count={3} at={{ x: 40, y: 20 }} strategy="absolute" />);
  expect(floating).toContain('data-slot="drag-preview-floating"');
  expect(floating).toContain('data-strategy="absolute"');
  expect(floating).toContain("translate:40px 20px");
  const fixed = renderToStaticMarkup(<DragPreview kind="tab" title="Shop" invalid at={{ x: 1, y: 2 }} />);
  expect(fixed).toContain('data-strategy="fixed"');
  expect(fixed).toContain('data-invalid="true"');
  expect(renderToStaticMarkup(<DragPreview kind="elements" images={[{ src: "a.png" }]} />)).not.toContain("drag-preview-floating");
});

test("Library images span the slot for typical shapes and sit inset only when extreme; chips show a glyph without a crop", () => {
  // Typical crops (the proposal's square chair cards, product cards, page views) span the 16:10 slot as on main.
  for (const [width, height] of [[120, 120], [216, 284], [320, 200], [3, 4], [12, 5]] as const) {
    expect({ width, height, fit: libraryImageFit(width, height) }).toEqual({ width, height, fit: "fill" });
  }
  // Extreme crops sit inset: the library smoke's 300×80 page-title crop (S6 evidence), a heading strip, a
  // line of text, a tall column.
  for (const [width, height] of [[600, 160], [640, 56], [640, 24], [180, 260], [5, 2], [7, 10]] as const) {
    expect({ width, height, fit: libraryImageFit(width, height) }).toEqual({ width, height, fit: "matte" });
  }
  expect(libraryImageFit(0, 0)).toBe("matte");
  const card = renderToStaticMarkup(<LibraryCard media={{ kind: "image", src: "crop.png" }} title="Office chairs" />);
  expect(card).toContain('data-fit="pending"'); // hidden until its shape is known
  const chip = renderToStaticMarkup(<ElementChip title="Office chairs" site="shop.example.com" />);
  expect(chip).toContain('data-empty="true"');
  expect(chip).not.toContain("<img");
});
