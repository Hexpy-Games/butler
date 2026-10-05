// Real product composer DOM and geometry; isolated native gateway, stub provider only.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { appCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { readComposerText } from "../support/transcript-layout-probe.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { createNativeAppServer } from "../support/native-app-server.ts";

const output = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? ".tmp/composer-controls/after");
mkdirSync(output, { recursive: true });
const releases: (() => void)[] = [];
const releaseReply = () => { for (const release of releases.splice(0)) release(); };
let markReplyStarted: (() => void) | undefined;
const replyStarted = new Promise<void>(done => { markReplyStarted = done; });
let holdReply = false;
const server = await createNativeAppServer({ stubReply: async () => {
  if (holdReply) {
    markReplyStarted?.();
    await new Promise<void>(done => { releases.push(done); });
  }
  return "Stub reply from the isolated smoke model.";
}, stubModelDisplayName: "Composer layout smoke model", uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist"), config: { user: { name: "Smoke", language: "en" } } });
const browser = await launchSmokeBrowser();
const measurements: unknown[] = [];
const selector = (name: string) => `[data-test-class~="${name}"]`;
const editorSelector = '[contenteditable="true"]';

async function geometry(page: Page) {
  return page.locator(selector("composer-card")).evaluate(card => {
    const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const row = document.querySelector('[data-test-class="composer-controls"]')!;
    const buttons = [...row.querySelectorAll("button")];
    const buttonContainer = row.querySelector('[data-slot="button-container"]')!;
    const spacer = buttonContainer.querySelector('[data-basis="0"]');
    return { card: rect(card), radius: getComputedStyle(card).borderRadius, row: rect(row),
      buttons: buttons.map(button => ({ ...rect(button), marker: button.getAttribute("data-test-class") })),
      layout: { container: rect(buttonContainer), spacer: spacer ? rect(spacer) : null, clientWidth: row.clientWidth, scrollWidth: row.scrollWidth, gap: getComputedStyle(buttonContainer).gap },
      send: rect(card.querySelector('[data-test-class="composer-send-button"]')!),
      pageOverflow: document.documentElement.scrollWidth - innerWidth };
  });
}

async function glassSurfaces(page: Page) {
  return page.locator(selector("composer-controls")).evaluate(row => {
    const surface = (marker: string) => getComputedStyle(row.querySelector(`[data-test-class~="${marker}"]`)!).backgroundColor;
    return { attachment: surface("attachment-button"), context: surface("context-donut-button") };
  });
}

async function assertAlwaysVisible(page: Page) {
  const before = await geometry(page);
  await page.locator(editorSelector).focus();
  await page.locator(selector("titlebar-title")).click();
  await page.locator(editorSelector).evaluate(element => (element as HTMLElement).blur());
  assert.deepEqual(await geometry(page), before, "outside click and blur preserve card and controls geometry");
  assert(await page.locator(selector("composer-controls")).isVisible());
  assert.equal(await page.locator('[data-slot="composer-compact-preview"]').count(), 0);
}

async function assertMenus(page: Page, markers = ["attachment-button", "access-button", "context-donut-button", "model-button"]) {
  for (const marker of markers) {
    const trigger = page.locator(selector(marker));
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    try {
      await page.locator('[data-state="open"][role="dialog"], [data-state="open"][role="listbox"]').last().waitFor();
    } catch (error) {
      console.log(JSON.stringify({ marker, state: await trigger.getAttribute("data-state"), expanded: await trigger.getAttribute("aria-expanded"), dialogs: await page.locator('[role="dialog"]').count() }));
      await page.screenshot({ path: `${output}/menu-failure.png` });
      throw error;
    }
    await page.keyboard.press("Escape");
    await page.locator('[data-slot="popover-content"], [data-slot="select-content"]').waitFor({ state: "hidden" });
    await page.waitForFunction(marker => document.activeElement?.getAttribute("data-test-class") === marker, marker);
    await page.mouse.move(0, 0);
  }
}

async function assertScroll(page: Page, inset = 0) {
  const row = page.locator(selector("composer-controls"));
  const fades = () => row.evaluate(element => {
    const css = getComputedStyle(element);
    return [css.getPropertyValue("--scroll-fade-start").trim(), css.getPropertyValue("--scroll-fade-end").trim()];
  });
  await row.evaluate(element => { element.scrollLeft = 0; });
  await page.waitForFunction(() => document.querySelector('[data-test-class="composer-controls"]')?.getAttribute("data-at-start") === "true" &&
    document.querySelector('[data-test-class="composer-controls"]')?.getAttribute("data-at-end") === "false");
  assert.deepEqual(await fades(), ["0px", "14px"]);
  const start = await geometry(page);
  assert(Math.abs(start.buttons[0]!.x - start.card.x - inset) < 1, "first circle flush with card start");
  await row.evaluate(element => { element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2; });
  await page.waitForFunction(() => document.querySelector('[data-test-class="composer-controls"]')?.getAttribute("data-at-start") === "false");
  assert.deepEqual(await fades(), ["14px", "14px"]);
  await row.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await page.waitForFunction(() => document.querySelector('[data-test-class="composer-controls"]')?.getAttribute("data-at-end") === "true");
  assert.deepEqual(await fades(), ["14px", "0px"]);
  const end = await geometry(page);
  assert(Math.abs(end.buttons.at(-1)!.right - end.card.right + inset) < 1, "last pill flush with card end");
}

async function replaceDraft(page: Page, text: string) {
  const editor = page.locator(editorSelector);
  await editor.focus();
  await editor.press("ControlOrMeta+A");
  await editor.press("Backspace");
  assert(await editor.evaluate(element => element === document.activeElement), "draft input owns focus");
  for (const [index, line] of text.split("\n").entries()) {
    if (index) await editor.press("Shift+Enter");
    if (line) await editor.pressSequentially(line);
  }
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function assertDraft(page: Page, width: number) {
  const editor = page.locator(editorSelector);
  await replaceDraft(page, "One\nTwo\nThree");
  assert.equal(await readComposerText(page), "One\nTwo\nThree", "complete three-line draft committed");
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const three = await geometry(page);
  assert.equal(three.card.height, width <= 520 ? 98 : 89);
  const lastLineCenter = await editor.evaluate(element => {
    const node = element.lastElementChild!;
    return node.getBoundingClientRect().bottom - parseFloat(getComputedStyle(element).lineHeight) / 2;
  });
  assert(Math.abs(three.send.y + three.send.height / 2 - lastLineCenter) <= 1, JSON.stringify({ three, lastLineCenter }));
  await replaceDraft(page, Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n"));
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  assert.equal(await readComposerText(page), Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n"), "all twelve lines retained");
  assert(await editor.evaluate(element => element.scrollHeight > element.clientHeight), "long draft scrolls inside editor");
  await replaceDraft(page, "");
}

async function assertPlanDecision(page: Page) {
  await page.route("**/session-view?*", async route => {
    const fetched = await route.fetch({ headers: { ...route.request().headers(), origin: new URL(server.url).origin } });
    assert.equal(fetched.status(), 200);
    const body = await fetched.json();
    const view = body.data ?? body;
    view.messages.push({ id: "composer-plan-smoke", role: "assistant", status: "sent", text: "Review the plan.", cursor: view.cursors.messages + 1,
      plan_document: { id: "composer-plan", kind: "plan", title: "Composer plan", status: "draft", markdown: "# Composer plan", safe_path_label: "Plan", updated_at: "2026-10-05T00:00:00Z" } });
    view.cursors.messages += 1;
    await route.fulfill({ json: body });
  });
  await page.reload();
  await page.locator(selector("attachment-button")).click();
  await page.getByRole("button", { name: appCopy.composer.plan, exact: true }).click();
  const decision = page.locator(selector("composer-plan-decision"));
  await decision.waitFor();
  for (const width of [375, 1280]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 900 });
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
    await page.locator(`[data-theme="${theme}"]`).first().waitFor();
    assert(await page.locator(selector("composer-controls")).isVisible(), "controls stay during plan decision");
    await page.screenshot({ path: `${output}/${width}-${theme}-plan.png` });
  }
  await decision.getByRole("button", { name: appCopy.composer.planInstruction, exact: true }).click();
  await page.locator(selector("composer-plan-instruction-context")).waitFor();
  assert(await page.locator(selector("composer-controls")).isVisible(), "controls stay while editing a plan instruction");
  assert(await page.locator(editorSelector).evaluate(editor => editor === document.activeElement), "plan instruction focuses the editor");
}

async function assertProjectControls(page: Page) {
  const name = "Composer controls project";
  await server.api("/projects", { method: "POST", body: JSON.stringify({ source: "scratch", display_name: name }) });
  const git = spawnSync("git", ["init", join(server.butlerData, "workspaces/projects", name)], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  await page.goto(server.url);
  const sidebar = page.locator(selector("app-sidebar"));
  const toggle = page.getByRole("button", { name: appCopy.titlebar.showLeftPanel, exact: true });
  await toggle.click();
  const row = sidebar.locator(selector("tree-row")).filter({ hasText: name }).last();
  await row.hover();
  await row.getByRole("button", { name: /dashboard/iu }).click();
  const hide = page.getByRole("button", { name: appCopy.titlebar.hideLeftPanel, exact: true });
  if (await hide.isVisible()) await hide.last().click();
  await assertMenus(page, ["composer-workspace-select"]);
  await page.locator(selector("attachment-button")).click();
  await page.getByRole("button", { name: appCopy.composer.plan, exact: true }).click();
  const plan = page.locator(selector("composer-plan-mode-badge"));
  await plan.waitFor();
  assert.equal(await plan.getAttribute("data-surface"), "glass-pill");
  await plan.click();
  assert.equal(await plan.count(), 0, "Plan click turns it off");
}

try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await server.signIn(page);
  await page.goto(server.url);
  const editor = page.locator(editorSelector);
  await editor.fill("Seed composer controls");
  await page.locator(selector("composer-send-button")).click();
  await page.locator(selector("context-donut-button")).waitFor();
  await page.getByText("Stub reply from the isolated smoke model.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  const hideSidebar = page.getByRole("button", { name: appCopy.titlebar.hideLeftPanel, exact: true });
  if (await hideSidebar.isVisible()) await hideSidebar.last().click();
  for (const width of [320, 375, 390, 430, 768, 1280]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 900 });
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
    await page.locator(`[data-theme="${theme}"]`).first().waitFor();
    const row = page.locator(selector("composer-controls"));
    await row.waitFor();
    const editor = page.locator(editorSelector);
    await replaceDraft(page, "");
    await page.evaluate(() => document.fonts.ready);
    const measured = await geometry(page);
    assert.equal(measured.card.height, measured.card.width <= 520 ? 50 : 47);
    assert.equal(measured.pageOverflow, 0);
    if ([320, 375, 390].includes(width)) {
      assert.equal(measured.layout.spacer, null, "overflow removes the grow spacer so it cannot add a second gap");
      const gaps = measured.buttons.slice(1).map((button, index) => button.x - measured.buttons[index]!.right);
      assert(gaps.length > 0, "composer controls expose adjacent pill gaps");
      for (const [index, gap] of gaps.entries()) assert(Math.abs(gap - 8) <= 0.5,
        `pill gap is 8px ±0.5px at ${width}px: ${JSON.stringify({ gap, left: measured.buttons[index], right: measured.buttons[index + 1], layout: measured.layout })}`);
    }
    if (theme === "dark") {
      await page.mouse.move(1, 1);
      const surfaces = await glassSurfaces(page);
      assert.equal(surfaces.attachment, surfaces.context,
        "the plus circle shares the context circle's dark glass surface");
      assert.notEqual(surfaces.attachment, "rgba(0, 0, 0, 0)", "the plus circle has a visible glass surface");
    }
    for (const marker of ["attachment-button", "context-donut-button"]) {
      const circle = measured.buttons.find(button => button.marker === marker)!;
      assert.equal(circle.width, width <= 640 ? 44 : 34);
      assert.equal(circle.height, circle.width, `${marker} is a true circle`);
    }
    assert.deepEqual(await page.locator(selector("context-donut-button")).locator("svg").evaluate(svg => {
      const box = svg.getBoundingClientRect(); return [box.width, box.height];
    }), [18, 18], "context ring keeps its size");
    assert.equal(measured.buttons[0]!.y - measured.card.bottom, 8, "visible card-to-pill gap");
    await assertAlwaysVisible(page);
    await assertDraft(page, measured.card.width);
    if (width === 375) await assertScroll(page);
    if (width === 1280) {
      assert(measured.layout.spacer && measured.layout.spacer.width > 0, "a fitting row keeps the grow spacer");
      assert(Math.abs(measured.buttons[0]!.x - measured.card.x) < 1);
      assert(Math.abs(measured.buttons.at(-1)!.right - measured.card.right) <= 0.5);
    }
    await assertMenus(page);
    await page.screenshot({ path: `${output}/${width}-${theme}-project.png` });
    measurements.push({ width, theme, ...measured });
  }
  await assertProjectControls(page);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const inset of [16, 32]) {
      await page.locator(selector("composer-card")).evaluate((card, inset) =>
        card.parentElement!.style.setProperty("--composer-controls-inset", `${inset}px`), inset);
      if (width === 375) await assertScroll(page, inset);
      else {
        const measured = await geometry(page);
        assert(Math.abs(measured.buttons[0]!.x - measured.card.x - inset) < 1);
        assert(Math.abs(measured.buttons.at(-1)!.right - measured.card.right + inset) < 1);
      }
    }
  }
  await page.locator(selector("composer-card")).evaluate(card => card.parentElement!.style.removeProperty("--composer-controls-inset"));
  holdReply = true;
  await replaceDraft(page, "Hold the stub reply");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await stop.waitFor();
  assert(await page.locator(selector("composer-controls")).isVisible(), "controls remain during an active turn");
  assert(await stop.evaluate(button => button.closest("form")?.contains(button)), "stop stays in the card");
  await replyStarted;
  holdReply = false;
  await stop.click();
  releaseReply();
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  await assertPlanDecision(page);
  console.log(JSON.stringify({ ok: true, measurements, modelCalls: server.stubModelCalls.length }));
} finally { releaseReply(); await browser.close(); await server.stop(); }
