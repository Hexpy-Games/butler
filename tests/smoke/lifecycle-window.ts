// Static public page: all states × themes × locales × feature flag, without pixel sampling.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser-args";

const directory = resolve("packages/butler-app/client/ui/lifecycle-assets");
const copy = JSON.parse(readFileSync(join(directory, "copy.json"), "utf8"));
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
let cases = 0;
mkdirSync(".tmp/lifecycle/static", { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 296, height: 264 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => assert.ok(request.url().startsWith("file:") || request.url().startsWith("data:"), "No network"));
  await page.addInitScript((copy) => {
    Object.assign(window, { butlerLifecycle: { state: async () => ({ ...Object.fromEntries(new URLSearchParams(location.search)), copy }), onState() {}, painted() {} } });
  }, copy);
  for (const kind of ["startup", "quit"]) {
    const states = kind === "startup" ? ["prepare", "service", "screen", "upgrade", "data", "slow", "error"]
      : ["saving", "search", "storage", "connections", "services", "finishing", "timeout", "failed"];
    for (const theme of ["light", "dark"]) for (const locale of ["ko", "en"]) for (const forceQuit of [false, true]) for (const state of states) {
      const stage = state === "slow" || state === "error" ? "service" : state === "timeout" || state === "failed" ? "storage" : state;
      const query = new URLSearchParams({ kind, state, stage, theme, locale, motion: "reduced" });
      await page.goto(`${pathToFileURL(join(directory, "lifecycle.html"))}?${query}`);
      await page.locator("html[data-painted=true]").waitFor();
      await page.evaluate((forceQuit) => (window as unknown as { lifecycleState(state: unknown): void }).lifecycleState({ forceQuit }), forceQuit);
      const height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
      await page.setViewportSize({ width: 296, height });
      await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
      const audit = await page.evaluate(() => {
        const mark = document.querySelector<HTMLCanvasElement>('[data-slot="mark"]')!;
        const visible = Array.from(document.querySelectorAll<HTMLElement>("[data-slot]"))
          .filter((element) => element.getBoundingClientRect().height > 0 && element.dataset.slot !== "mark" && element.dataset.slot !== "rolling-swap" && element.dataset.slot !== "actions");
        return { images: document.images.length, surface: getComputedStyle(document.body.firstElementChild!).backgroundColor, mark: { width: mark.width, height: mark.height, visible: mark.getBoundingClientRect().width === 48 }, overflow: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
          elements: visible.map((element) => {
            const rect = element.getBoundingClientRect();
            const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return { slot: element.dataset.slot, text: element.textContent, fits: element.scrollWidth <= element.clientWidth,
              uncovered: top === element || element.contains(top), height: rect.height, size: parseFloat(getComputedStyle(element).fontSize) };
          }), scripts: Array.from(document.scripts, (script) => ({ src: script.src.split("/").pop(), type: script.type })),
          status: document.querySelector('[role="status"]')?.getAttribute("aria-live"), titleRole: document.querySelector('[data-slot="title"]')!.getAttribute("role") };
      });
      assert.equal(audit.images, 0, "Lifecycle has no wallpaper or still");
      assert.equal(audit.surface, theme === "light" ? "color(srgb 1 1 1)" : "color(srgb 0.137255 0.141176 0.152941)");
      assert.ok(audit.mark.width > 0 && audit.mark.height > 0 && audit.mark.visible);
      assert.deepEqual(audit.overflow, [296, height], `${kind}/${state}/${theme}/${locale}/${forceQuit}`);
      assert.deepEqual(audit.scripts, [{ src: "mark.js", type: "" }, { src: "state.js", type: "" }]);
      assert.ok(audit.elements.some((element) => element.slot === "title"), "Card title remains visible");
      assert.equal(audit.status, "polite");
      assert.equal(audit.titleRole, ["error", "failed"].includes(state) ? "alert" : "heading");
      for (const element of audit.elements) {
        assert.ok(element.fits && element.uncovered, JSON.stringify({ kind, state, theme, locale, element }));
        if (["secondary", "primary"].includes(element.slot!)) assert.equal(element.height, 28);
        if (element.slot === "title") assert.equal(element.size, 15);
        if (["line", "detail"].includes(element.slot!)) assert.equal(element.size, 14);
        if (element.slot === "caption") assert.equal(element.size, 12);
      }
      if (!forceQuit) assert.ok(!audit.elements.some((e) => e.text === copy[locale].action.forceQuit));
      if (!forceQuit && locale === "ko" && ["service", "saving", "error", "failed"].includes(state)) {
        await page.screenshot({ path: `.tmp/lifecycle/static/${kind}-${state}-${theme}.png` });
      }
      cases++;
    }
  }
  await page.goto(`${pathToFileURL(join(directory, "lifecycle.html"))}?kind=startup&stage=service&theme=dark&locale=ko&motion=auto`);
  await page.locator("html[data-painted=true]").waitFor();
  assert.equal(await page.evaluate(() => {
    const classes = JSON.parse(document.documentElement.dataset.classes!);
    return Array.from(document.querySelectorAll("[aria-hidden=true]")).some((element) => element.className === classes.outgoing);
  }), false, "Initial copy must not roll a placeholder above the first painted line");
  assert.deepEqual(errors, []);
  console.log(`PASS: ${cases} static lifecycle cases, desktop sizes, stacking, accessibility, no network or app bundle.`);
} finally { await browser.close(); }
