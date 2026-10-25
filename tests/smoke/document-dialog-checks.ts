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

export async function measureDocumentLayout(page: Page) {
  const geometry = await page.locator('[role="dialog"][data-height="full"]').evaluate(dialog => {
    const rect = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const body = dialog.querySelector('[data-slot="document-dialog-body"]')!;
    const row = dialog.querySelector('[data-slot="document-dialog-header-row"]') ?? dialog.querySelector('[data-slot="dialog-header"]')!.firstElementChild!;
    const title = dialog.querySelector('[data-slot="dialog-title"]')!;
    const text = title.firstElementChild ?? title;
    const actions = [...row.querySelectorAll('button')].map(rect);
    const heading = dialog.querySelector('[data-document-id] h1')!;
    const note = dialog.querySelector('[data-slot="document-dialog-note"]');
    const styles = getComputedStyle(dialog);
    const token = document.createElement('div'); token.style.width = 'var(--space-3)'; dialog.append(token);
    const expectedSpacing = token.getBoundingClientRect().width; token.remove();
    return { dialog: rect(dialog), row: rect(row), body: rect(body), heading: rect(heading), actions,
      title: { ...rect(text), scrollWidth: text.scrollWidth, clientWidth: text.clientWidth, overflow: getComputedStyle(text).textOverflow, whiteSpace: getComputedStyle(text).whiteSpace },
      headerToHeading: rect(heading).y - rect(row).bottom,
      noteGap: note ? rect(note).y - rect(row).bottom : null,
      gaps: actions.slice(1).map((action, index) => action.x - actions[index]!.right),
      bodyRight: rect(dialog.querySelector('[data-document-id]')!).right,
      expectedSpacing, dialogPadding: parseFloat(styles.paddingRight),
      samples: { header: { x: rect(body).x + 2, y: rect(row).y + 2 }, body: { x: rect(body).x + 2, y: rect(body).y + 2 } } };
  });
  const png = await page.screenshot({ animations: "disabled", caret: "hide" });
  const colors = await page.evaluate(async ({ png, samples }) => {
    const img = new Image(); img.src = `data:image/png;base64,${png}`; await img.decode();
    const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext("2d")!; ctx.drawImage(img, 0, 0);
    const sample = ({ x, y }: { x: number; y: number }) => [...ctx.getImageData(Math.round(x * img.width / innerWidth), Math.round(y * img.height / innerHeight), 1, 1).data].slice(0, 3);
    return { header: sample(samples.header), body: sample(samples.body) };
  }, { png: png.toString("base64"), samples: geometry.samples });
  return { ...geometry, colors };
}

export function assertDocumentLayout(layout: Awaited<ReturnType<typeof measureDocumentLayout>>, width: number) {
  const close = layout.actions.at(-1)!;
  assert(Math.abs(close.right - layout.bodyRight) <= 2, JSON.stringify(layout));
  assert(layout.colors.header.every((value, i) => Math.abs(value - layout.colors.body[i]!) <= 3), JSON.stringify(layout));
  if (width === 390) {
    assert(layout.title.scrollWidth > layout.title.clientWidth && layout.title.overflow === "ellipsis" && layout.title.whiteSpace === "nowrap", JSON.stringify(layout));
    assert(Math.max(...layout.gaps) - Math.min(...layout.gaps) <= 1 && layout.gaps.every(gap => gap >= 0), JSON.stringify(layout));
    assert(Math.abs(layout.dialog.right - close.right - layout.dialogPadding) <= 2, JSON.stringify(layout));
  }
  if (layout.noteGap !== null) assert(layout.noteGap >= 0 && layout.noteGap <= 6, JSON.stringify(layout));
}
