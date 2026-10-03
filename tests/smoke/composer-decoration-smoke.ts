import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser";

// Browser smoke: real DS composition, motion lifecycle, input cost and review captures.
const dist = resolve("packages/butler-app/client/ui/dist-ds-site");
const output = resolve(".tmp/composer-decor2");
mkdirSync(output, { recursive: true });
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const file = resolve(dist, `.${pathname === "/" ? "/index.html" : pathname}`);
    return file.startsWith(`${dist}/`) ? new Response(Bun.file(file)) : new Response(null, { status: 404 });
  },
});
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 1 });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const themes = ["none", "coastal", "cherry-blossom", "flower-field", "characters"];
const editor = () => page.getByRole("textbox", { name: "Ask Butler anything", exact: true });
const canvas = () => page.locator("[data-composer-decoration] canvas");
const samples: unknown[] = [];

async function visit(tone = "light", width = 1280) {
  await page.setViewportSize({ width, height: 960 });
  await page.goto(`${server.url}index.html?page=patterns/composer-decorations&theme=${tone}`, { waitUntil: "networkidle" });
  await page.locator("[data-ds-composer-decorations]").waitFor({ state: "visible" });
}

async function frames() {
  return Number(await canvas().getAttribute("data-frames"));
}

async function stable(label: string) {
  await page.waitForTimeout(200);
  const before = await frames();
  await page.waitForTimeout(400);
  assert.equal(await frames(), before, `${label}: should not draw`);
}

async function structure(target: Page) {
  return target.locator('[data-test-class="composer-card"]').first().evaluate((form) => {
    const clone = form.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("[data-composer-decoration]").forEach((node) => node.remove());
    const nodes = [clone, ...clone.querySelectorAll("*")];
    return nodes.map((node) => ({ tag: node.tagName, cls: node.className, slot: node.getAttribute("data-slot") }));
  });
}

async function captures() {
  for (const width of [1280, 375]) for (const tone of ["light", "dark"]) {
    await visit(tone, width);
    await page.getByRole("radio", { name: "Static", exact: true }).click();
    await editor().fill("Summarize the motion tokens.");
    for (const theme of themes) {
      await page.getByLabel("Decoration", { exact: true }).selectOption(theme);
      if (theme !== "none") await canvas().waitFor();
      await page.waitForTimeout(150);
      const shape = await structure(page);
      assert.deepEqual(shape, baseline, `${theme}: ComposerCard structure changed`);
      assert.equal(await page.locator('[data-test-class="composer-card"] [role="textbox"]').count(), 1);
      assert.equal(await page.locator('[data-test-class="composer-toolbar"]').count(), 1);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `${width}/${tone}/${theme}: horizontal overflow`);
      const sendInside = await page.getByRole("button", { name: "Send", exact: true }).evaluate((button) => {
        const card = button.closest("form")!.getBoundingClientRect();
        const rect = button.getBoundingClientRect();
        return rect.left >= card.left && rect.right <= card.right && rect.bottom <= card.bottom;
      });
      assert(sendInside, `${width}/${theme}: send button clipped`);
      await page.screenshot({ path: `${output}/${width}-${tone}-${theme}.png` });
      if (width === 375) {
        await page.locator("[data-decoration-perf]").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/${width}-${tone}-${theme}-controls.png` });
        await page.getByRole("heading", { name: "Composer decorations", exact: true }).scrollIntoViewIfNeeded();
      }
    }
  }
}

async function motion() {
  await visit();
  for (const theme of themes.slice(1)) {
    await page.getByLabel("Decoration", { exact: true }).selectOption(theme);
    await canvas().waitFor();
    await editor().fill("Complete draft stays editable.");
    await page.waitForTimeout(300);
    const start = await frames();
    await page.waitForTimeout(1000);
    const count = await frames() - start;
    assert(count <= 21, `${theme}: exceeded 20fps cap (${count})`);
    if (theme === "coastal" || theme === "cherry-blossom") assert(count >= 1, `${theme}: live scene stopped`);
    await page.getByRole("radio", { name: "Static", exact: true }).click();
    await stable(`${theme}/static`);
    await editor().pressSequentially(" Still.");
    await stable(`${theme}/static typing`);
    await page.getByRole("radio", { name: "Interactive", exact: true }).click();
    await page.getByLabel("Reduce motion", { exact: true }).check();
    await stable(`${theme}/viewer reduce motion`);
    await page.getByLabel("Reduce motion", { exact: true }).uncheck();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await stable(`${theme}/OS reduce motion`);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await editor().pressSequentially(" Measured input.", { delay: 15 });
    await page.waitForTimeout(1400);
    const metric = await canvas().evaluate((node) => ({ ...((node as HTMLElement).dataset) }));
    assert(Number(metric.inputP99) < 1, `${theme}: input p99 >=1ms`);
    assert(Number(metric.inputs) === 16, `${theme}: every committed input must be counted`);
    assert.equal(await editor().innerText(), "Complete draft stays editable. Still. Measured input.");
    samples.push({ theme, framesInSecond: count, ...metric });
    if (theme === "flower-field" || theme === "characters") await stable(`${theme}/idle`);
  }
}

async function visibility() {
  await visit();
  await page.getByLabel("Decoration", { exact: true }).selectOption("coastal");
  await canvas().waitFor();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await stable("hidden document signal");
  await page.evaluate(() => {
    delete (document as unknown as { visibilityState?: string }).visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
    const stage = document.querySelector<HTMLElement>("[data-decoration-stage]")!;
    stage.style.transform = "translateY(2000px)";
  });
  await stable("offscreen IntersectionObserver");
  await page.locator("[data-decoration-stage]").evaluate((stage) => { stage.style.transform = ""; });
  await page.waitForTimeout(200);
  const before = await frames();
  await page.waitForTimeout(400);
  assert(await frames() > before, "visible coastal did not resume");
  await page.getByLabel("Decoration", { exact: true }).selectOption("none");
  assert.equal(await canvas().count(), 0, "none must release the canvas");
}

async function options() {
  await visit();
  await page.getByLabel("Decoration", { exact: true }).selectOption("characters");
  await page.getByLabel("Keep inside", { exact: true }).check();
  assert(await page.locator('form [data-composer-decoration="characters"]').count(), "inside characters must be clipped by the card");
  await page.getByLabel("App wallpaper", { exact: true }).check();
  assert.equal(await page.locator('[data-decoration-stage] [data-test-class="wallpaper"]').count(), 1);
  await page.getByLabel("375 frame", { exact: true }).check();
  assert.equal(Math.round((await page.locator("[data-decoration-stage]").boundingBox())!.width), 375);
  await page.getByLabel("Intensity", { exact: true }).focus();
  await page.getByLabel("Intensity", { exact: true }).press("End");
  await page.screenshot({ path: `${output}/1280-light-characters-inside-wallpaper-375.png` });
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await page.screenshot({ path: `${output}/1280-dark-characters-inside-wallpaper-375.png` });
  for (const width of [320, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 960 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: overflow`);
  }
}

let baseline: Awaited<ReturnType<typeof structure>>;
try {
  await page.goto(`${server.url}?page=blocks/ComposerCard`, { waitUntil: "networkidle" });
  await page.locator('[data-test-class="composer-card"]').first().getByRole("textbox").fill("Summarize the motion tokens.");
  baseline = await structure(page);
  await captures();
  await motion();
  await visibility();
  await options();
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/measurements.json`, `${JSON.stringify(samples, null, 2)}\n`);
  console.log(JSON.stringify({ screenshots: 32, errors, samples }, null, 2));
} finally {
  await browser.close();
  server.stop(true);
}
