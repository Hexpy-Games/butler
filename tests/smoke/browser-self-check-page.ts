// Renderer-side fixture proof; Electron transport/performance is a separate smoke.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
// @ts-expect-error Shared backend-independent renderer script is native ESM.
import { checkScript } from "../../packages/butler-app/client/electron/browser/page/check.mjs";

type Layout = { overflow: number; blank: boolean; warnings: string[] };

const evidence = process.env.BUTLER_BROWSER_EVIDENCE!;
mkdirSync(evidence, { recursive: true });
const browser = await launchSmokeBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors: string[] = [];
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", error => errors.push(error.message));
try {
  await page.setContent("<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><title>Fixture</title><style>body{margin:0}h1{width:1290px}</style><h1>Output</h1><script>console.error('fixture console error');throw new Error('fixture exception')</script><a href='/absolute'>link</a>");
  const desktop = await page.evaluate<Layout>(checkScript);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate<Layout>(checkScript);
  assert.equal(mobile.overflow, 900);
  assert.equal(desktop.blank, false);
  assert(mobile.warnings.includes("root_absolute_paths"));
  assert(errors.some(message => message.includes("fixture console error")));
  assert(errors.some(message => message.includes("fixture exception")));
  const image = await page.screenshot({ type: "jpeg", quality: 75 });
  assert(image.length <= 150 * 1024);
  writeFileSync(join(evidence, "page-mobile.jpg"), image);
  await page.setContent("<!doctype html><h1>Fixed</h1>");
  const repaired = await page.evaluate<Layout>(checkScript);
  assert.equal(repaired.overflow, 0);
  assert.equal(repaired.blank, false);
  writeFileSync(join(evidence, "page.json"), JSON.stringify({ desktop, mobile, errors, repaired, image_bytes: image.length, backend: "Playwright renderer; Electron unverified" }, null, 2));
  console.log(`Renderer fixture passed: mobile overflow 900px, ${errors.length} errors, JPEG ${image.length}B`);
} finally { await browser.close(); }
