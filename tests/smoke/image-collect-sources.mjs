/** Offline browser pixels, including cross-origin hotlink-protected images. */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { imageSourceScript } from "../../packages/butler-app/client/electron/browser/page/collect-image.mjs";
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
const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const size = Number(new URL(request.url).pathname.match(/^\/(\d+)\.svg$/u)?.[1]);
  if (size) return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="blue"/></svg>`, { headers: { "content-type": "image/svg+xml" } });
  return new Response(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: http://127.0.0.1:${cdn.port}; connect-src 'none'"><img alt="embedded" src="data:image/jpeg;base64,${jpg.toString("base64")}"><img alt="CDN" src="http://127.0.0.1:${cdn.port}/photo.jpg"><img alt="renditions" src="/128.svg" srcset="/128.svg 128w, /640.svg 640w" sizes="128px" data-original="/800.svg" data-zoom-image="/960.svg"><a href="/1024.svg" type="image/svg+xml"><img alt="original link" src="/128.svg"></a>`, { headers: { "content-type": "text/html", "set-cookie": "photos=yes; SameSite=Lax; Path=/" } });
} });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BUTLER_SMOKE_CHROMIUM, args: ["--single-process"] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${site.port}`);
  await page.locator("img").evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.evaluate(() => { globalThis.__butlerObservation = { obs: "obs", epoch: 1, refs: new Map([...document.images].map((image, i) => [`img${i}`, new WeakRef(image)])) }; });
  const embedded = await page.evaluate(imageSourceScript({ ref: "img0", obs: "obs", epoch: 1 }));
  assert.equal(embedded.image.data, jpg.toString("base64"), "embedded bytes survive CSP without a fetch");
  const cross = await page.evaluate(imageSourceScript({ ref: "img1", obs: "obs", epoch: 1 }));
  assert.equal(cross.capture_element, true, "tainted canvas requests host element capture");
  const pixels = await page.locator('img[alt="CDN"]').screenshot({ path: `${evidence}/cdn-element.png` });
  assert.ok(pixels.length > 100);
  assert.equal(requests, 1, "collect uses the already-loaded CDN pixels");
  for (const [ref, size] of [["img2", 960], ["img3", 1024]]) {
    const selected = await page.evaluate(imageSourceScript({ ref, obs: "obs", epoch: 1 }));
    assert.equal(selected.width, size); assert.equal(selected.height, size);
    assert.ok(selected.image.data.length > 100);
    assert.ok(selected.source_url.endsWith(`/${size}.svg`));
  }
  const byUrl = await page.evaluate(imageSourceScript({ url: `http://127.0.0.1:${site.port}/128.svg` }));
  assert.equal(byUrl.width, 960); assert.equal(byUrl.height, 960);
  const blocked = await page.evaluate(async () => { try { await fetch(document.images[0].src); return false; } catch { return true; } });
  assert.equal(blocked, true, "original embedded fetch is blocked by page CSP");
  await page.screenshot({ path: `${evidence}/csp-cdn-fixture.png` });
  console.log("CSP embedded source retained; CDN loaded once; same-element renditions 128 → 960 / 1024 pixels");
} finally {
  await browser?.close();
  site.stop(true); cdn.stop(true);
}
