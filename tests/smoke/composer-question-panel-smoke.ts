import { resolve } from "node:path";
import { chromium, type Locator } from "playwright";

// DS Viewer behavior/layout smoke; static presenter only, no provider or owner data.
const root = resolve("packages/butler-app/client/ui/dist-ds-site");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  return new Response(Bun.file(resolve(root, path === "/" ? "index.html" : `.${path}`)));
} });
const browser = await chromium.launch({ headless: true });
let focused = 0;

async function assertFocus(target: Locator) {
  await target.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await target.focus();
  const problem = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const shadow = style.boxShadow;
    const inset = style.outlineStyle !== "none" && Number.parseFloat(style.outlineOffset) < 0;
    if (!element.matches(":focus-visible")) return "keyboard focus missing";
    if (!inset && shadow === "none") return "visible focus missing";
    const extra = inset ? 0 : 2;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      if (css.overflowX !== "visible" && (rect.left - extra < box.left - 1 || rect.right + extra > box.right + 1)) return "horizontal ring clipped";
      if (css.overflowY !== "visible" && (rect.top - extra < box.top - 1 || rect.bottom + extra > box.bottom + 1)) return `vertical ring clipped (${element.textContent || element.getAttribute("aria-label")}; parent ${parent.className}; ${rect.top},${rect.bottom} vs ${box.top},${box.bottom})`;
    }
    return null;
  });
  if (problem) throw new Error(`${problem}: ${await target.getAttribute("data-slot")}`);
  focused++;
}

async function verifyActions(panel: Locator) {
  const actions = panel.locator('[data-slot="button-container"]');
  const delta = await actions.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const parent = element.parentElement!;
    return parent.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(parent).paddingRight) - box.right;
  });
  if (Math.abs(delta) > 1) throw new Error(`actions not right aligned: ${delta}`);
}

async function verifyPanel(panel: Locator) {
  const controls = panel.locator('button:enabled:not([role="tab"]), input:enabled, [role="radio"], [role="checkbox"], [role="button"][data-disabled="false"]');
  for (const control of await controls.all()) await assertFocus(control);
}

try {
  for (const width of [375, 1280]) for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    await page.goto(`http://127.0.0.1:${server.port}/?page=blocks/ComposerQuestionPanel&width=${width}&locale=${locale}&theme=${theme}&motion=reduced`);
    const panels = page.locator('[data-ds-examples] [data-slot="composer-question-panel"]');
    await panels.first().waitFor();
    await page.keyboard.press("Tab");
    if (await panels.locator("kbd").count()) throw new Error("keyboard hints remain");
    for (const panel of await panels.all()) {
      await verifyActions(panel);
      if (await panel.getAttribute("aria-busy") === "true" || await panel.getAttribute("data-state") === "working") continue;
      await assertFocus(panel);
      const tabs = panel.getByRole("tab");
      if (await tabs.count()) {
        for (const tab of await tabs.all()) { await assertFocus(tab); await verifyPanel(panel); }
      } else await verifyPanel(panel);
    }
    const schedule = panels.nth(3);
    await schedule.getByRole("tab").first().focus();
    await schedule.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const inset = await schedule.locator('[data-slot="tabs-list"]').evaluate((element) => {
      const box = element.getBoundingClientRect();
      const panel = element.closest('[data-slot="composer-question-panel"]')!.getBoundingClientRect();
      return Math.min(box.left - panel.left, panel.right - box.right);
    });
    if (inset < 8) throw new Error("tab viewport touches rounded panel edges");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: `/tmp/question-tabs-${width}-${locale}-${theme}.png` });
    const multi = panels.nth(1);
    await multi.focus();
    await page.keyboard.press("Space");
    if (await multi.getByRole("checkbox").nth(1).getAttribute("aria-checked") !== "true") throw new Error("Space did not toggle choice");
    await page.keyboard.press("ArrowDown");
    await assertFocus(multi.getByRole("checkbox").nth(2));
    await page.keyboard.press("ArrowUp");
    await assertFocus(multi.getByRole("checkbox").nth(1));
    await page.keyboard.press("7");
    const extra = multi.getByRole("textbox");
    await assertFocus(extra);
    await extra.fill("Custom notification");
    await page.keyboard.press("Enter");
    await page.getByText(/Custom notification/u).first().waitFor();
    const single = panels.first();
    const other = single.getByRole("radio").last();
    await single.focus();
    for (let index = 0; index < 3; index++) await page.keyboard.press("ArrowDown");
    await assertFocus(other);
    const before = await other.boundingBox();
    await page.keyboard.press("Enter");
    const input = single.getByRole("textbox");
    await input.waitFor();
    const after = await input.boundingBox();
    if (!before || !after || after.y > before.y + before.height) throw new Error("custom input left option row");
    await assertFocus(input);
    await input.fill(locale === "ko" ? "직접 정한 위치" : "Custom location");
    await page.screenshot({ path: `/tmp/question-panel-${width}-${locale}-${theme}.png` });
    await page.keyboard.press("Escape");
    if (await single.getByRole("textbox").count()) throw new Error("Escape did not close custom entry");
    await single.focus();
    await page.keyboard.press("3");
    await page.getByText(locale === "ko" ? "답변 완료" : "Answered", { exact: true }).first().waitFor();
    await page.close();
    console.log(`PASS ${width} ${locale} ${theme}`);
  }
  console.log(`PASS 8 Viewer combinations; ${focused} interactive focus checks`);
} finally { await browser.close(); server.stop(true); }
