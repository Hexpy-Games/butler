// UI behavior E2E: hold asset requests to prove geometry before decode.
import { probeFocusRing } from "../support/focus-ring-clipping";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, Route } from "playwright";

let release: (() => void) | undefined;
let held: Promise<void> | undefined;
export async function sizingAsset(route: Route) {
  await held;
  const small = route.request().url().includes("img_small");
  const [width, height] = small ? [120, 80] : [3000, 2000];
  return route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 300 200"><rect width="300" height="200" fill="#8ca5ab"/><circle cx="210" cy="65" r="26" fill="#efd79c"/><path d="M0 200V150L90 60L220 200M120 200L220 110L300 180V200" fill="#55766d"/></svg>` });
}

export async function checkImageSizing(page: Page,
  open: (page: Page, spec: unknown, width: number, theme: string) => Promise<void>,
  width: number, theme: string, stage: string, locale: string, evidence: string,
  labels: { view: (name: string) => string; close: string }) {
  const spec = JSON.parse(readFileSync(join(import.meta.dir, "answer-blocks-mock.json"), "utf8")).imageSizing;
  held = new Promise<void>(resolve => { release = resolve; });
  try {
    await open(page, spec, width, theme);
    const blocks = page.locator('[data-answer-block="image"]');
    await blocks.last().waitFor();
    const frames = blocks.locator('[data-slot="media-frame"]');
    const boxes = await frames.evaluateAll(nodes => nodes.map(node => {
      const frame = node.getBoundingClientRect(), target = node.closest('[role="button"]')!.getBoundingClientRect();
      const container = node.closest('[data-answer-block]')!.getBoundingClientRect();
      return { width: frame.width, height: frame.height, target: { width: target.width, height: target.height }, container: container.width,
        loaded: (node.querySelector("img") as HTMLImageElement).complete };
    }));
    if (stage === "after") {
      assert.equal(boxes.length, 4);
      boxes.forEach((box, index) => {
        const expected = Math.min(index % 2 === 0 ? 120 : 1500, box.container);
        assert(Math.abs(box.width - expected) < 1, JSON.stringify({ width, index, expected, box }));
        assert(Math.abs(box.height - expected * 2 / 3) < 1, "3:2 is reserved before decode");
        assert(!box.loaded, "asset request remains held");
        assert(Math.abs(box.target.width - box.width) < 1 && Math.abs(box.target.height - box.height) < 1, `click target hugs frame: ${JSON.stringify({ width, index, box })}`);
      });
    }
    release!(); held = undefined;
    await frames.locator("img").evaluateAll(nodes => Promise.all(nodes.map(node => (node as HTMLImageElement).decode())));
    if (stage === "after") {
      await blocks.nth(1).getByRole("button", { name: labels.view("Large image"), exact: true }).click();
      const dialog = page.getByRole("dialog"); await dialog.waitFor();
      const image = dialog.locator("img");
      await image.evaluate(node => (node as HTMLImageElement).decode());
      assert.equal(await image.evaluate(node => (node as HTMLImageElement).naturalWidth), 3000);
      assert(!(await image.getAttribute("src"))!.includes("w="), "viewer uses full asset");
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
      const target = blocks.first().getByRole("button", { name: labels.view("Small image"), exact: true });
      await target.scrollIntoViewIfNeeded(); await target.focus();
      const ring = await probeFocusRing(page);
      assert(ring && !ring.noIndicator && ring.clips.length === 0, JSON.stringify(ring));
      for (const key of ["Enter", " "]) {
        await target.focus(); await page.keyboard.press(key); await dialog.waitFor();
        await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
      }
    }
    await page.locator('[data-slot="image-viewer-overlay"]').waitFor({ state: "detached" });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('[data-test-class~="conversation-scroll"]').evaluate(node => { node.scrollTop = 0; });
    await page.setViewportSize({ width, height: stage === "before" ? 3000 : 1600 });
    await page.screenshot({ path: join(evidence, `${locale}-${stage}-image-blocks-${width}-${theme}-plain.jpg`), type: "jpeg", quality: 80 });
    console.log(JSON.stringify({ imageSizing: { width, theme, boxes } }));
    return { imageSizing: { width, theme, boxes } };
  } finally { release?.(); held = undefined; }
}
