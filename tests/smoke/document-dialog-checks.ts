// UI behavior smoke: modal coverage, hit testing and projected image geometry.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";

export async function checkDocumentDialog(page: Page, width: number, evidence: string) {
  const geometry = await page.locator('[role="dialog"][data-height="full"]').evaluate(dialog => {
    const container = dialog.parentElement!;
    const overlay = container.querySelector('[data-slot="dialog-overlay"]')!;
    const rect = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const box = rect(dialog), area = { x: 0, y: 0, width: innerWidth, height: innerHeight, right: innerWidth, bottom: innerHeight }, scrim = rect(overlay);
    const pane = document.querySelector('[data-slot="conversation-aside"]');
    const title = rect(dialog.querySelector('[data-slot="dialog-title"]')!);
    const close = rect(dialog.querySelector('[data-slot="dialog-close"]')!);
    const points = [[box.x - 2, box.y + box.height / 2], [box.right + 2, box.y + box.height / 2],
      [box.x + box.width / 2, box.y - 2], [box.x + box.width / 2, box.bottom + 2],
      [area.x + area.width / 2, area.bottom - 2]];
    return { box, area, scrim, pane: pane ? rect(pane) : null,
      titleCenter: title.y + title.height / 2, closeCenter: close.y + close.height / 2,
      hits: points.map(([x, y]) => ({ x, y, slot: document.elementFromPoint(x!, y!)?.getAttribute("data-slot") })) };
  });
  const { box, area, scrim, pane } = geometry;
  assert(box.x >= area.x && box.y >= area.y && box.right <= area.right && box.bottom <= area.bottom, JSON.stringify(geometry));
  assert(Math.abs(box.height - (area.height - 2 * (box.y - area.y))) < 1, "full height reaches the viewport cap");
  assert.deepEqual(scrim, area, "the scrim covers the entire viewport");
  assert(geometry.hits.every(hit => hit.slot === "dialog-overlay"), JSON.stringify(geometry));
  assert(Math.abs(geometry.titleCenter - geometry.closeCenter) <= 2, JSON.stringify(geometry));
  if (width === 1440) {
    assert(pane && scrim.x <= pane.x && scrim.right >= pane.right && scrim.y <= pane.y && scrim.bottom >= pane.bottom, JSON.stringify(geometry));
  }
  writeFileSync(join(evidence, `dialog-geometry-${width}.json`), JSON.stringify(geometry, null, 2));
}

export async function checkDocumentImage(page: Page, width: number, evidence: string, scope = "[data-document-id]") {
  const frames = page.locator(`${scope} [data-slot="media-frame"]`);
  await frames.first().waitFor();
  const boxes = await frames.evaluateAll(nodes => nodes.map(node => {
    const r = node.getBoundingClientRect(), parent = node.parentElement!.getBoundingClientRect();
    return { width: r.width, height: r.height, x: r.x, parentX: parent.x, available: parent.width,
      natural: node.hasAttribute("data-natural"), cssWidth: (node as HTMLElement).style.getPropertyValue("--media-natural-width") };
  }));
  for (const box of boxes) {
    assert(box.natural && box.cssWidth === "600px", JSON.stringify(box));
    const expected = Math.min(600, box.available);
    assert(Math.abs(box.width - expected) < 1 && Math.abs(box.height - expected * 2 / 3) < 1, JSON.stringify(box));
    assert(Math.abs(box.x - box.parentX) < 1, "image starts at the inline start");
    if (width === 1440) assert.equal(box.width, 600);
  }
  await frames.locator("img").evaluateAll(nodes => Promise.all(nodes.map(node => (node as HTMLImageElement).decode())));
  writeFileSync(join(evidence, `document-images-${width}.json`), JSON.stringify(boxes, null, 2));
}
