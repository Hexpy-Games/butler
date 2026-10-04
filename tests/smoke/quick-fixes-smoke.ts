// Browser harness: product Lexical editor, observer and Models settings; stub data only.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser";

const root = resolve("packages/butler-app/client/ui/dist");
const output = resolve(".tmp/quick-fixes");
mkdirSync(output, { recursive: true });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const file = Bun.file(join(root, new URL(request.url).pathname));
  return new Response(await file.exists() ? file : Bun.file(join(root, "index.html")));
} });
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
const measurements: unknown[] = [];
let keyboardCases = 0;
async function open(page: Page, query: string) {
  await page.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=quick-fixes&${query}`);
  await page.locator('[data-harness-ready="true"]').waitFor();
}
async function submissions(page: Page) {
  return JSON.parse((await page.locator("[data-submissions]").getAttribute("data-submissions"))!) as string[];
}
async function composer(page: Page) {
  const text = "  첫째 줄 hello\n둘째 줄 한국어  ";
  for (const modifier of ["Meta", "Control"]) for (const position of ["start", "middle", "end"]) {
    await open(page, "mode=composer");
    const editor = page.locator('[contenteditable="true"]');
    await editor.fill(text);
    await editor.evaluate((element, position) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes: Node[] = []; while (walker.nextNode()) nodes.push(walker.currentNode);
      const node = position === "end" ? nodes.at(-1)! : nodes[0];
      const range = document.createRange();
      range.setStart(node, position === "end" ? node.textContent!.length : position === "middle" ? 3 : 0);
      range.collapse(true); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    }, position);
    await editor.press(`${modifier}+Enter`);
    assert.deepEqual(await submissions(page), [text], `${modifier} at ${position} sends exact text`);
    assert.equal(await editor.innerText(), text, "send key leaves draft unchanged");
    keyboardCases++;
  }
  for (const modifier of ["Meta", "Control"]) {
    await open(page, "mode=composer");
    const editor = page.locator('[contenteditable="true"]');
    await editor.fill("한국어 ");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 });
    await editor.press(`${modifier}+Enter`);
    assert.deepEqual(await submissions(page), [], "composition must not submit");
    await cdp.send("Input.insertText", { text: "한" });
    await cdp.detach();
    assert.equal(await editor.innerText(), "한국어 한", "shortcut must not alter Korean composition");
    // Some IMEs end composition before the final keydown and report keyCode 229.
    await editor.evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", keyCode: 229, ctrlKey: true, bubbles: true, cancelable: true,
    })));
    assert.deepEqual(await submissions(page), [], "IME confirmation key does not send");
    await editor.press(`${modifier}+Enter`);
    assert.deepEqual(await submissions(page), ["한국어 한"], "after IME sends committed text exactly");
    keyboardCases++;
  }
  for (const send of ["modifier_enter_send_enter_newline", "enter_send_shift_enter_newline", "enter_newline_shift_enter_send"]) {
    await open(page, `mode=composer&send=${send}`);
    const editor = page.locator('[contenteditable="true"]');
    await editor.fill("hello"); await editor.press("End"); await editor.press("Enter");
    if (send === "enter_send_shift_enter_newline") assert.deepEqual(await submissions(page), ["hello"]);
    else { assert.deepEqual(await submissions(page), []); await editor.press("x"); assert.equal(await editor.innerText(), "hello\nx"); }
    keyboardCases++;
  }
}
async function activity(page: Page, width: number, theme: string) {
  for (const state of ["running", "completed"]) {
    await open(page, `mode=activity&theme=${theme}&state=${state}`);
    const conversation = page.locator('[data-test-class~="turn-work-collapsed"]').first();
    await conversation.locator('[data-test-class="toggle-turn-activity-disclosure"]').click();
    await conversation.locator('[data-test-class~="turn-work-tool-group"] > button').click();
    const tools = await conversation.locator('[data-test-class="turn-work-tool-detail-row"]').allTextContents();
    assert.equal(tools.length, 2, "conversation has both tools");
    await page.getByRole("button", { name: "위임 작업", exact: true }).click();
    const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
    await dialog.waitFor();
    const toggle = dialog.locator('[data-test-class="toggle-turn-activity-disclosure"]');
    assert.equal(await toggle.count(), 1, "observer retains the work's activity record");
    await toggle.click();
    await dialog.locator('[data-test-class~="turn-work-tool-group"] > button').click();
    assert.deepEqual(await dialog.locator('[data-test-class="turn-work-tool-detail-row"]').allTextContents(), tools, "same projected DS tool rows, including completed work");
    assert.equal(await dialog.locator('[data-work-block-id="research"]').count(), 1);
    await dialog.locator('[data-test-class="turn-work-tool-detail-row"]').last().waitFor({ state: "visible" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().every(animation =>
      animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
    await page.screenshot({ path: join(output, `work-${state}-${width}-${theme}-ko.png`) });
  }
}
async function settings(page: Page, width: number, theme: string, locale = "ko") {
  await open(page, `mode=settings&theme=${theme}&locale=${locale}`);
  const row = page.locator('[data-test-class="settings-models-advanced"]');
  const trigger = row.locator('[data-slot="clickable"]');
  await trigger.hover();
  const geometry = await trigger.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const title = element.querySelector('[data-slot="disclosure-row-title"]')!.getBoundingClientRect();
    const css = getComputedStyle(element);
    return { top: title.top - rect.top, bottom: rect.bottom - title.bottom,
      paddingTop: css.paddingTop, paddingBottom: css.paddingBottom, background: css.backgroundColor };
  });
  measurements.push({ width, theme, locale, ...geometry });
  assert(geometry.top >= 4 && Math.abs(geometry.top - geometry.bottom) <= 1, `symmetric hover inset: ${JSON.stringify(geometry)}`);
  assert.equal(geometry.paddingTop, geometry.paddingBottom);
  assert.notEqual(geometry.background, "rgba(0, 0, 0, 0)", "hover is highlighted");
  assert.equal(await trigger.innerText(), locale === "ko" ? "기억 정리 모델과 작업자 설정" : "Memory cleanup model and worker settings");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(output, `settings-${width}-${theme}-${locale}.png`) });
  await trigger.click();
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator('[data-settings-section-id="worker-profiles"]').count(), 1);
  if (locale === "ko") assert(!/Worker/u.test(await page.locator('[data-settings-section-id="worker-profiles"]').innerText()));
}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
  await page.route("**/credentials", route => route.fulfill({ json: { data: { credentials: [] } } }));
  const only = process.env.BUTLER_QUICK_FIX_CASE;
  if (!only || only === "composer") await composer(page);
  for (const width of [1280, 375]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 1000 });
    if (!only || only === "activity") await activity(page, width, theme);
    if (!only || only === "settings") await settings(page, width, theme);
  }
  if (!only || only === "settings") await settings(page, 375, "dark", "en");
  console.log(JSON.stringify({ ok: true, keyboardCases, measurements, modelCalls: 0, screenshots: output }));
} finally { await browser.close(); server.stop(true); }
