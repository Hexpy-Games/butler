// Native App settings + composer behavior, stub only; no pixel sampling.
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { getAppCopy } from "../../packages/butler-i18n/src/index";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { installComposerRenderProbe, readComposerRenderProbe, resetComposerRenderProbe } from "../support/composer-render-probe";
import { settingsReady } from "./appearance-perf-support";

const baseline = Bun.argv.includes("--baseline");
const out = resolve(".tmp/composer-fold", baseline ? "before" : "after");
mkdirSync(out, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve(baseline ? ".tmp/composer-fold/baseline-dist" : "packages/butler-app/client/ui/dist") });
const browser = await launchSmokeBrowser();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const card = page.locator('[data-test-class~="composer-card"]');
const editor = card.locator('[contenteditable="true"]');
const toggle = page.getByRole("switch", { name: "입력창 접기", exact: true });
const results: unknown[] = [];
const timings: number[] = [];
let interactionChatIds: string[] = [];

async function frames() {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function capture(name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
}

async function sidebar() {
  const show = page.getByRole("button", { name: "사이드바 보기", exact: true });
  if (await show.isVisible()) await show.click();
}

async function closeSidebarOverlay() {
  if (page.viewportSize()!.width >= 640) return;
  const hide = page.locator('[data-test-class~="chrome-floating-toggle-layer"]').getByRole("button", { name: "사이드바 숨기기", exact: true });
  if (await hide.isVisible()) await hide.click();
}

async function appearance() {
  await sidebar();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await settingsReady(page);
  await page.getByRole("button", { name: "모양", exact: true }).click();
  await page.locator('[data-settings-section-id="home-screen"]').waitFor();
}

async function workspace() {
  if (page.viewportSize()!.width < 640) {
    await page.getByRole("button", { name: "돌아가기", exact: true }).click();
  }
  await page.locator('[data-test-class~="settings-header"]').getByRole("button", { name: "돌아가기", exact: true }).click();
  await card.waitFor();
  await closeSidebarOverlay();
}

async function state(expanded: boolean) {
  await page.waitForFunction((expected) => document.querySelector('[data-test-class~="composer-card"]')?.getAttribute("data-expanded") === String(expected), expanded, { timeout: 5000 });
  if (expanded) {
    for (const control of ["attachment-button", "access-button", "model-button", "composer-send-button"]) {
      assert(await card.locator(`[data-test-class~="${control}"]`).isVisible(), `${control} must be visible`);
    }
    // Context usage is rendered only after the native session has context.
    const contextControl = card.locator('[data-test-class~="context-donut-button"]');
    if (await contextControl.count()) assert(await contextControl.isVisible(), "Context control must be visible when available");
  } else {
    assert(await card.locator('[data-slot="composer-compact-preview"]').isVisible());
    assert(!(await card.locator('[data-test-class~="model-button"]').isVisible()));
    await card.locator('[data-slot="composer-expanded-body"][data-state="closed"]').waitFor({ state: "attached" });
    await frames();
    const transitionHeight = (await card.boundingBox())!.height;
    await card.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
    const settledHeight = (await card.boundingBox())!.height;
    if (settledHeight > 68) {
      console.log("fold geometry", await card.evaluate((node) => ({ expanded: node.dataset.expanded, active: document.activeElement?.tagName, children: [...node.children].map((child) => ({ slot: child.getAttribute("data-slot"), state: child.getAttribute("data-state"), height: child.getBoundingClientRect().height, cssHeight: getComputedStyle(child).height })) })));
    }
    assert(settledHeight <= 68, `Existing idle one-row budget: ${settledHeight}px`);
    results.push({ transitionHeight, settledHeight });
  }
}

async function timedToggle() {
  await toggle.scrollIntoViewIfNeeded();
  const saved = page.waitForResponse((r) => r.url().endsWith("/settings") && r.request().method() === "PATCH");
  const ms = await toggle.evaluate(async (node: HTMLElement) => {
    const next = node.getAttribute("aria-checked") !== "true";
    const start = performance.now();
    node.click();
    while ((node.getAttribute("aria-checked") === "true") !== next) {
      if (performance.now() - start > 150) throw new Error("Switch exceeded 150ms");
      await new Promise(requestAnimationFrame);
    }
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return performance.now() - start;
  });
  assert(ms <= 150, `Toggle exceeded settings budget: ${ms}ms`);
  timings.push(ms);
  assert((await saved).ok());
  await page.waitForFunction(() => !document.querySelector('[data-setting-id="collapse-message-box"] [role="switch"]')?.hasAttribute("disabled"));
}

async function setDraft(text: string) {
  await editor.focus();
  await editor.press("ControlOrMeta+A");
  await editor.press("Backspace");
  if (text) await editor.pressSequentially(text);
  await frames();
}

async function interactions(collapse: boolean, prefix: string) {
  await closeSidebarOverlay();
  await state(!collapse);
  if (collapse) await card.locator('[data-slot="composer-compact-preview"]').click();
  await capture(`${prefix}-engaged-${collapse ? "on" : "off"}`);
  await setDraft("Preserve complete composer draft through blur and outside click");
  await frames();
  await editor.evaluate((node) => (node as HTMLElement).blur());
  await frames();
  await closeSidebarOverlay();
  await state(!collapse);
  if (collapse) await card.locator('[data-slot="composer-compact-preview"]').click();
  await frames();
  await page.mouse.click(2, 2);
  await state(!collapse);
  await capture(`${prefix}-${collapse ? "folded" : "expanded"}`);
  if (collapse) await card.locator('[data-slot="composer-compact-preview"]').click();
  await setDraft("");
  await frames();
  await editor.evaluate((node) => (node as HTMLElement).blur());
  await frames();
  await sidebar();
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/session-view" && new URL(r.url()).searchParams.get("session_id") === interactionChatIds[1]),
    page.getByText("Fold smoke B", { exact: true }).click(),
  ]);
  await state(!collapse);
  await sidebar();
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/session-view" && new URL(r.url()).searchParams.get("session_id") === interactionChatIds[0]),
    page.getByText("Fold smoke A", { exact: true }).click(),
  ]);
  await closeSidebarOverlay();
  await state(!collapse);
  if (collapse) await card.locator('[data-slot="composer-compact-preview"]').click();
  // Existing typing smoke drains the sidebar replay before measuring input alone.
  await page.waitForTimeout(1800);
  await setDraft("D");
  await frames();
  await resetComposerRenderProbe(page);
  await editor.pressSequentially("raft integrity 0123456789", { delay: 10 });
  await frames();
  const renders = await readComposerRenderProbe(page);
  assert.equal(renders["composer-shell"] ?? 0, 0, "No shell render per keystroke");
  assert.equal(await editor.innerText(), "Draft integrity 0123456789");
  results.push({ prefix, collapse, renders });
  await setDraft("");
  await editor.evaluate((node) => (node as HTMLElement).blur());
  await frames();
}

async function liveApply(collapse: boolean) {
  const ms = await page.evaluate(async (value) => {
    const start = performance.now();
    const response = await fetch("/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ collapse_message_box: value }) });
    if (!response.ok) throw new Error("Live settings update failed");
    while (document.querySelector('[data-test-class~="composer-card"]')?.getAttribute("data-expanded") !== String(!value)) {
      if (performance.now() - start > 150) throw new Error("Live setting exceeded 150ms");
      await new Promise(requestAnimationFrame);
    }
    await new Promise(requestAnimationFrame);
    return performance.now() - start;
  }, collapse);
  assert(ms <= 150, `Composer settings application exceeded 150ms: ${ms}`);
  timings.push(ms);
  await state(!collapse);
}

function storedSettings() {
  const db = new Database(join(server.butlerData, "app-server/butler-client.sqlite"), { readonly: true });
  try { return db.query("SELECT value_json, updated_at FROM app_settings WHERE key='settings'").get(); }
  finally { db.close(); }
}

try {
  await installComposerRenderProbe(page);
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const composer = document.querySelector('[data-test-class~="composer-card"]');
      if (!composer) return;
      (window as any).__firstComposerExpanded = composer.getAttribute("data-expanded");
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await server.signIn(context);
  // 600 chats exercise the existing owner-scale navigation, with full membership checks.
  const ids: string[] = [];
  for (let i = 0; i < 600; i += 10) {
    const rows = await Promise.all(Array.from({ length: 10 }, (_, j) => server.api<any>("/sessions", {
      method: "POST", body: JSON.stringify({ kind: "chat", title: i + j >= 598 ? `Fold smoke ${i + j === 598 ? "A" : "B"}` : `Fold scale ${i + j}` }),
    })));
    ids.push(...rows.map((row) => row.session.id));
  }
  interactionChatIds = ids.slice(-2);
  const nav = await server.api<any>("/navigation");
  assert(ids.every((id) => nav.chats.some((chat: any) => chat.id === id)), "Owner-scale chat membership");
  for (const width of [1280, 375]) for (const theme of ["light", "dark"]) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme, collapse_message_box: true, wallpaper: { source: { kind: "none" } } }) });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(server.url);
    await card.waitFor();
    const prefix = `${width}-${theme}`;
    await capture(`${prefix}-loaded-folded`);
    await appearance();
    if (!baseline) {
      assert.equal(await toggle.getAttribute("aria-checked"), "true");
      await page.getByText("입력하지 않을 때 입력창을 한 줄로 줄입니다.", { exact: true }).waitFor();
      await toggle.scrollIntoViewIfNeeded();
    }
    await capture(`${prefix}-setting`);
    if (!baseline) {
      await timedToggle();
      assert.equal((await server.api<any>("/settings")).collapse_message_box, false);
      const before = storedSettings();
      await server.api("/settings", { method: "PATCH", body: JSON.stringify({ collapse_message_box: false }) });
      assert.deepEqual(storedSettings(), before, "Unchanged setting must not write settings row");
      await workspace();
      await interactions(false, prefix);
      await page.evaluate(() => localStorage.removeItem("butler:settings:v1"));
      await page.reload();
      await state(true);
      assert.equal(await page.evaluate(() => (window as any).__firstComposerExpanded), "true", "Cold load must start expanded without a renderer settings cache");
      await capture(`${prefix}-loaded-expanded`);
      await appearance();
      await timedToggle();
    }
    await workspace();
    await interactions(true, prefix);
    if (!baseline) { await liveApply(false); await liveApply(true); }
  }
  if (!baseline) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en" }) });
    await page.reload();
    await card.waitFor();
    const copy = getAppCopy("en-US");
    const show = page.getByRole("button", { name: copy.titlebar.showLeftPanel, exact: true });
    if (await show.isVisible()) await show.click();
    await page.getByRole("button", { name: copy.sidebar.settings, exact: true }).click();
    await settingsReady(page);
    await page.getByRole("button", { name: copy.settings.sections.appearance, exact: true }).click();
    const english = page.getByRole("switch", { name: "Collapse message box", exact: true });
    await english.scrollIntoViewIfNeeded();
    await page.getByText("Shrink the message box to one line when you're not typing.", { exact: true }).waitFor();
    await capture("375-dark-setting-en");
  }
  assert.equal(server.stubModelCalls.length, 0);
  writeFileSync(join(out, "results.json"), JSON.stringify({ chats: ids.length, timings, results, maxMs: Math.max(0, ...timings) }, null, 2));
  console.log(`PASS: ${results.filter((row: any) => typeof row.collapse === "boolean").length} composer cases, 600 chats; max toggle ${Math.max(0, ...timings).toFixed(1)}ms; no model calls`);
} catch (error) {
  console.error(error);
  console.log("failure state", await card.count() ? await card.evaluate((node) => ({ expanded: node.dataset.expanded, active: document.activeElement?.tagName, children: [...node.children].map((child) => ({ slot: child.getAttribute("data-slot"), state: child.getAttribute("data-state"), height: child.getBoundingClientRect().height })) })).catch(() => null) : null);
  await page.screenshot({ path: join(out, "failure.png"), fullPage: true }).catch(() => undefined);
  throw error;
} finally {
  try {
    await page.goto("about:blank");
    await browser.close();
  } finally { await server.stop(); }
}
