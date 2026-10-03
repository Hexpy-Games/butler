import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import type { Page } from "playwright";
import { checkCoastalLifecycle } from "./composer-coastal-checks";
import { checkDecorationLifecycle } from "./composer-decoration-lifecycle";

interface Metrics { edits: number; frames: number; mainMs: number; maxInputMs: number; active: boolean }
const metrics = (page: Page): Promise<Metrics> => page.locator("[data-decoration-perf]").evaluate(node => JSON.parse((node as HTMLElement).dataset.metrics!));
const idle = (page: Page) => page.waitForFunction(() => {
  const raw = document.querySelector<HTMLElement>("[data-decoration-perf]")?.dataset.metrics;
  return raw && !JSON.parse(raw).active;
});

async function composition(page: Page) {
  const input = page.getByRole("textbox", { name: "Try your message" });
  await input.fill("");
  await idle(page);
  const before = await metrics(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ㅎ", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 });
  assert.equal((await metrics(page)).edits, before.edits, "IME candidates must not pulse");
  await cdp.send("Input.insertText", { text: "한" });
  await page.waitForTimeout(400);
  assert.equal(await input.inputValue(), "한", "Korean commit preserved");
  assert.equal((await metrics(page)).edits, before.edits + 1, "one pulse for IME commit");
  const committed = await metrics(page);
  await cdp.send("Input.imeSetComposition", { text: "ㄱ", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
  await page.waitForTimeout(400);
  assert.equal((await metrics(page)).edits, committed.edits, "cancelled composition must not pulse");
  await cdp.detach();
}

async function staticChecks(page: Page) {
  for (const control of ["Mode", "Reduce motion"]) {
    if (control === "Mode") await page.getByLabel(control, { exact: true }).selectOption("static");
    else await page.getByRole("switch", { name: control, exact: true }).check();
    const before = await metrics(page);
    await page.getByRole("textbox", { name: "Try your message" }).pressSequentially("static");
    await page.waitForTimeout(400);
    assert.deepEqual(await metrics(page), before, `${control} must remain static`);
    if (control === "Mode") await page.getByLabel(control, { exact: true }).selectOption("interactive");
    else await page.getByRole("switch", { name: control, exact: true }).uncheck();
  }
}

async function framing(page: Page) {
  const input = page.getByRole("textbox", { name: "Try your message" });
  await input.fill("첫 줄\nSecond line\n세 번째\n4\n5\n6\n7\n8");
  const text = await input.inputValue();
  for (const theme of ["flowers", "cherry", "characters", "coastal", "none"]) {
    await page.getByLabel("Decoration", { exact: true }).selectOption(theme);
    assert.equal(await input.inputValue(), text, "theme changes retain the complete draft");
    assert.equal(await page.locator("[data-decoration-layer]").getAttribute("aria-hidden"), "true");
    if (theme !== "none") {
      const art = await page.locator("[data-decoration-layer]").boundingBox();
      const editor = await input.boundingBox();
      assert(art && editor && art.y <= editor.y && art.y + art.height >= editor.y + editor.height,
        "the decoration fills the card behind the entire editor");
      const hit = await input.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === node;
      });
      assert(hit, "art must not intercept editor input");
    }
    if (theme === "characters") {
      const toggle = page.getByRole("switch", { name: "Peek over edge" });
      for (const peek of [false, true]) {
        await toggle.setChecked(peek);
        const art = await page.locator("[data-decoration-layer]").boundingBox();
        const character = await page.locator("[data-decor-sprite]").first().boundingBox();
        assert(art && character && (peek ? character.y < art.y : character.y >= art.y), "character clipping option");
      }
    }
    if (theme === "coastal") await checkCoastalLifecycle(page);
  }
}

export async function checkDecorations(page: Page) {
  await page.getByRole("textbox", { name: "Try your message" }).waitFor();
  await composition(page);
  await staticChecks(page);
  await checkDecorationLifecycle(page);
  await framing(page);
  assert.equal(await page.getByLabel("Placement", { exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Coastal framing").count(), 0);
  await page.getByRole("textbox", { name: "Try your message" }).fill("오늘은 어떤 이야기를 해볼까요?\nA small thought, a little room to grow.");
  await page.getByRole("switch", { name: "375 frame", exact: true }).check();
  await page.getByRole("switch", { name: "Photo wallpaper", exact: true }).check();
  await mkdir(".tmp/composer-decorations", { recursive: true });
  for (const tone of ["light", "dark"]) {
    await page.getByLabel("Appearance", { exact: true }).selectOption(tone);
    for (const theme of ["flowers", "cherry", "characters", "coastal"]) {
      await page.getByLabel("Decoration", { exact: true }).selectOption(theme);
      await page.waitForTimeout(100);
      await page.screenshot({ path: `.tmp/composer-decorations/${theme}-${tone}.png`, fullPage: true });
    }
  }
  for (const width of [320, 375, 390, 430, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
  }
  await page.getByRole("switch", { name: "375 frame", exact: true }).uncheck();
  await page.getByRole("switch", { name: "Photo wallpaper", exact: true }).uncheck();
}
