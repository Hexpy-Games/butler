// UI behavior smoke: detect background content showing through the document dialog.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";

export async function compareDocumentBackdrop(page: Page, name: string, evidence: string) {
  const dialog = page.locator('[role="dialog"][data-height="full"]');
  const clip = await dialog.boundingBox(), body = await dialog.locator('[data-slot="document-dialog-body"]').boundingBox();
  assert(clip && body);
  const normal = await page.screenshot({ clip, animations: "disabled", caret: "hide", path: join(evidence, `opacity-${name}-normal.png`) });
  const originals = await page.locator('[data-test-class~="conversation-scroll"], [data-test-class~="composer-wrap"]').evaluateAll(nodes => nodes.map(node => {
    const original = node.getAttribute("style");
    (node as HTMLElement).style.setProperty("visibility", "hidden", "important");
    return original;
  }));
  assert(originals.length >= 2, "hide both the transcript and composer behind the dialog");
  let hidden: Buffer;
  try {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    hidden = await page.screenshot({ clip, animations: "disabled", caret: "hide", path: join(evidence, `opacity-${name}-hidden.png`) });
  } finally {
    await page.locator('[data-test-class~="conversation-scroll"], [data-test-class~="composer-wrap"]').evaluateAll((nodes, originals) => nodes.forEach((node, index) => {
      const original = originals[index];
      if (original === null) node.removeAttribute("style"); else node.setAttribute("style", original!);
    }), originals);
  }
  const result = await page.evaluate(async ({ normal, hidden, clip, body }) => {
    const read = async (src: string) => {
      const img = new Image(); img.src = `data:image/png;base64,${src}`; await img.decode();
      const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(img, 0, 0);
      return { width: img.width, height: img.height, pixels: ctx.getImageData(0, 0, img.width, img.height).data };
    };
    const first = await read(normal), second = await read(hidden);
    if (first.width !== second.width || first.height !== second.height) throw new Error("Dialog crop dimensions changed");
    let changed = 0, bodyChanged = 0, minX = first.width, minY = first.height, maxX = -1, maxY = -1;
    const rows: { y: number; changed: number }[] = [];
    for (let y = 0; y < first.height; y++) {
      let rowChanged = 0;
      for (let x = 0; x < first.width; x++) {
        const i = (y * first.width + x) * 4;
        if (![0, 1, 2].some(channel => Math.abs(first.pixels[i + channel]! - second.pixels[i + channel]!) > 8)) continue;
        changed++; rowChanged++;
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        if (x + clip.x >= body.x && x + clip.x < body.x + body.width && y + clip.y >= body.y && y + clip.y < body.y + body.height) bodyChanged++;
      }
      if (rowChanged) rows.push({ y: y + clip.y, changed: rowChanged });
    }
    return { clip, body, pixels: first.width * first.height, changed, bodyChanged, chromeChanged: changed - bodyChanged,
      changedFraction: changed / (first.width * first.height),
      changedBounds: changed ? { left: minX + clip.x, top: minY + clip.y, right: maxX + clip.x, bottom: maxY + clip.y } : null, rows };
  }, { normal: normal.toString("base64"), hidden: hidden!.toString("base64"), clip, body });
  writeFileSync(join(evidence, `opacity-${name}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ opacity: name, ...result, rows: undefined }));
  return result;
}
