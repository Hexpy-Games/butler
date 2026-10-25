// A title-bar pane toggle fills with its pane's own surface, opaque, while the pane is open (IconButton `pane`).
import { strict as assert } from "node:assert";
import type { Page } from "playwright";

export const paneToggles = {
  aside: '[data-test-class="session-info-toggle"]',
  browser: '[data-test-class="titlebar-browser-toggle"]',
  viewer: '[data-test-class="titlebar-file-viewer-toggle"]',
} as const;

/** Each pane's surface: the browser sheet and the viewer card by their painted background, the aside by its glass tint. */
const paneSurfaces = {
  aside: '[data-slot="conversation-aside"] [data-slot="tinted-glass"], [data-slot="conversation-aside"]',
  browser: '[data-slot="browser-pane"]',
  viewer: '[data-slot="adaptive-shell-split-pane"] [data-test-class="file-viewer"]',
} as const;

/** The toggle's fill and the pane surface it must match, both resolved by the engine (alpha dropped from the surface). */
async function readFill(page: Page, pane: keyof typeof paneToggles) {
  return page.evaluate(({ pane, selector, surfaceSelector }) => {
    const button = document.querySelector<HTMLElement>(selector);
    if (!button) throw new Error(`${pane} toggle is missing`);
    const surfaceElement = document.querySelector<HTMLElement>(surfaceSelector);
    const surface = !surfaceElement ? null : pane === "aside" ? getComputedStyle(surfaceElement).getPropertyValue("--tinted-glass-tint").trim()
      : getComputedStyle(surfaceElement).backgroundColor;
    const probe = document.createElement("span");
    if (surface) probe.style.backgroundColor = `rgb(from ${surface} r g b / 1)`;
    document.body.append(probe);
    const expected = surface ? getComputedStyle(probe).backgroundColor : null;
    probe.remove();
    return { pane: button.getAttribute("data-pane"), pressed: button.getAttribute("aria-pressed"), fill: getComputedStyle(button).backgroundColor, surface, expected };
  }, { pane, selector: paneToggles[pane], surfaceSelector: paneSurfaces[pane] });
}

/** Closed: no fill (pointer parked off the toggle). Open: the fill equals the open pane's surface made opaque. */
export async function verifyPaneToggleFill(page: Page, pane: keyof typeof paneToggles, open: boolean) {
  await page.mouse.move(4, 600);
  // The fill fades in on --motion-fast (a colour change, kept under reduced motion): read it once settled.
  await page.locator(paneToggles[pane]).evaluate(async (button) => { await Promise.all(button.getAnimations().map((animation) => animation.finished)); });
  const read = await readFill(page, pane);
  assert.equal(read.pane, pane, `${pane} toggle declares its pane`);
  assert.equal(read.pressed, String(open));
  if (!open) assert.equal(read.fill, "rgba(0, 0, 0, 0)", `${pane} toggle is unfilled while its pane is closed`);
  else {
    assert(read.expected, `${pane} pane surface resolves`);
    assert.equal(read.fill, read.expected, `${pane} toggle fill matches its pane's surface (${read.surface})`);
  }
  return read;
}
