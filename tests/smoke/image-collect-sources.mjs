/** Offline browser pixels, including cross-origin hotlink-protected images. */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { imageSource } from "../../packages/butler-app/client/electron/browser/page/collect-image.mjs";
const evidence = process.env.BUTLER_E2E_BROWSER_EVIDENCE;
assert.ok(evidence, "evidence directory required");
mkdirSync(evidence, { recursive: true });
const root = "packages/butler-agent/rust/crates/butler-e2e/tests/e2e";
const jpg = readFileSync(`${root}/browser_outputs/pixel.jpg`);
let requests = 0;
const cdn = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  requests++;
  assert.ok(request.headers.get("referer"), "CDN requires the page Referer");
  assert.ok(request.headers.get("cookie")?.includes("photos=yes"), "CDN requires the page cookie");
  return new Response(jpg, { headers: { "content-type": "image/jpeg", "cache-control": "max-age=3600" } });
} });
const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
  return new Response(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src data: http://127.0.0.1:${cdn.port}; connect-src 'none'"><img alt="embedded" src="data:image/jpeg;base64,${jpg.toString("base64")}"><img alt="CDN" src="http://127.0.0.1:${cdn.port}/photo.jpg">`, { headers: { "content-type": "text/html", "set-cookie": "photos=yes; SameSite=Lax; Path=/" } });
} });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BUTLER_SMOKE_CHROMIUM, args: ["--single-process"] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${site.port}`);
  await page.locator("img").evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.evaluate(() => { globalThis.__butlerObservation = { obs: "obs", epoch: 1, refs: new Map([...document.images].map((image, i) => [`img${i}`, new WeakRef(image)])) }; });
  const embedded = await page.evaluate(`(${imageSource.toString()})(${JSON.stringify({ ref: "img0", obs: "obs", epoch: 1 })})`);
  assert.equal(embedded.image.data, jpg.toString("base64"), "embedded bytes survive CSP without a fetch");
  const cross = await page.evaluate(`(${imageSource.toString()})(${JSON.stringify({ ref: "img1", obs: "obs", epoch: 1 })})`);
  assert.equal(cross.capture_element, true, "tainted canvas requests host element capture");
  assert.equal(cross.fetch_source, true, "a withheld photo names its own file for the host");
  assert.equal(cross.source_url, `http://127.0.0.1:${cdn.port}/photo.jpg`);
  assert.equal(cross.referer, `http://127.0.0.1:${site.port}/`, "the host download carries the page Referer");
  const pixels = await page.locator('img[alt="CDN"]').screenshot({ path: `${evidence}/cdn-element.png` });
  assert.ok(pixels.length > 100);
  assert.equal(requests, 1, "collect uses the already-loaded CDN pixels");
  const blocked = await page.evaluate(async () => { try { await fetch(document.images[0].src); return false; } catch { return true; } });
  assert.equal(blocked, true, "original embedded fetch is blocked by page CSP");
  await page.screenshot({ path: `${evidence}/csp-cdn-fixture.png` });
  console.log("CSP embedded source retained; CDN loaded once; host element capture available");
} finally {
  await browser?.close();
  site.stop(true); cdn.stop(true);
}
