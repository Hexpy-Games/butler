// Public settings -> real native gateway -> composer; stub providers only.
import { strict as assert } from "node:assert";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { NewChatBriefingView, SettingsView } from "../../packages/butler-app/client/ui/src/app/types";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { createNativeAppServer, writeOnboardingComplete } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { distribution, installDecorationProbe, readDecorationProbe, resetDecorationProbe } from "../support/composer-decoration-probe";

const before = Bun.argv.includes("--before");
const scrollOnly = Bun.argv.includes("--scroll-only");
const startsOnly = Bun.argv.includes("--starts-only");
const panelsOnly = Bun.argv.includes("--panels-only");
let longReply = false;
const LAST_MESSAGE = "Last complete message. This text must remain above the character and input.";
const LONG_MESSAGE = Array.from({ length: 60 }, (_, i) => `Complete transcript paragraph ${i + 1}.`).join("\n\n") + `\n\n${LAST_MESSAGE}`;
const out = resolve(`.tmp/composer-decoration/${before ? "before" : "after"}`);
mkdirSync(out, { recursive: true });
let toolMode: "question" | "authority" | undefined;
let toolPrompt: string | undefined;
const isToolRequest = (request: import("../support/native-app-server").StubModelRequest) =>
  request.stream && toolMode && toolPrompt && JSON.stringify(request.body).includes(toolPrompt);
const server = await createNativeAppServer({ uiRoot: resolve(before ? ".tmp/composer-before-dist" : "packages/butler-app/client/ui/dist"),
  stubReply: request => isToolRequest(request) ? "" : request.stream ? (longReply ? LONG_MESSAGE : LAST_MESSAGE) : "{}",
  stubToolCall: request => {
    if (!isToolRequest(request)) return null;
    const mode = toolMode; toolMode = undefined;
    if (mode === "question") return { name: "ask_user", arguments: { questions: [{ id: "format", eyebrow: "Format", title: "Which format?", kind: "single", allow_custom: true,
      options: [{ id: "brief", label: "Brief", recommended: true }, { id: "full", label: "Full" }] }] } };
    if (mode === "authority") return { name: "write_file", arguments: { path: join(server.butlerData, "decoration-smoke.txt"), content: "Scoped smoke", overwrite: false } };
    return null;
  } });
const browser = await launchSmokeBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await installDecorationProbe(page);
await server.signIn(page);
const scene = '[data-test-class~="composer-decoration-scene"]';
const editor = '[contenteditable="true"]';
const results: unknown[] = [];
function recordCase(result: unknown) {
  results.push(result);
  writeFileSync(join(out, "progress.json"), JSON.stringify({ complete: false, cases: results }, null, 2));
}

async function capture(page: Page, name: string) {
  await page.locator('[data-test-class="composer-card"], [data-test-class~="settings-detail-title"]').first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLCanvasElement>('[data-test-class~="wallpaper"]')].every(canvas =>
    canvas.dataset.module === "none" || (canvas.width > 0 && canvas.height > 0 && getComputedStyle(canvas).visibility === "visible")));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(a =>
    a.effect?.getTiming().iterations === Infinity || a.playState !== "running"));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(out, `${name}.png`) });
}
async function settings(page: Page, language: "en" | "ko") {
  const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: copy.commandPalette.label });
  await palette.getByRole("combobox").fill(copy.settings.sections.appearance);
  await palette.getByRole("option").filter({ hasText: copy.settings.sections.appearance }).click();
  return copy;
}
async function openEditor(page: Page) {
  const preview = page.locator('[data-slot="composer-compact-preview"]');
  if (await preview.isVisible()) await preview.click();
  await page.locator(editor).waitFor();
}
async function firstFrame(page: Page) {
  // Crossfade releases visibility only from its drawn() first-frame callback.
  await page.waitForFunction((selector) => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector);
    return canvas && canvas.width > 0 && canvas.height > 0 && canvas.style.visibility !== "hidden";
  }, scene);
  assert((await readDecorationProbe(page)).draws > 0, "actual first draw observed");
}
function diskSnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name); const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else result[path.slice(root.length)] = `${stat.size}:${stat.mtimeMs}`;
    }
  };
  walk(root); return result;
}
async function typing(page: Page) {
  await openEditor(page);
  await page.locator(editor).fill("Seed ");
  await resetDecorationProbe(page);
  const text = "complete typing probe with forty characters";
  await page.locator(editor).pressSequentially(text, { delay: 40 });
  assert.equal(await page.locator(editor).innerText(), `Seed ${text}`);
  const probe = await readDecorationProbe(page);
  assert.equal(probe.commits.length, text.length, "each keystroke committed completely");
  assert.equal(probe.decorationRenders, 0, "zero decoration renders during typing");
  await page.locator(editor).fill("");
  return distribution(probe.commits);
}
async function characterGeometry(page: Page) {
  const geometry = await page.evaluate(() => {
    const wrap = document.querySelector("[data-edge-reserve]")!;
    const head = wrap.querySelector('[data-character="crab"]')!.getBoundingClientRect();
    const input = document.querySelector('[contenteditable="true"]')!;
    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT);
    const textRects: DOMRect[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange(); range.selectNodeContents(node);
      textRects.push(...range.getClientRects());
    }
    const controls = [...document.querySelectorAll('[data-test-class="composer-card"] button')]
      .map(button => button.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
    const scroll = document.querySelector('[data-test-class~="conversation-scroll"]');
    return { head: { top: head.top, bottom: head.bottom }, textTop: Math.min(...textRects.map(rect => rect.top)), textLines: textRects.length,
      controlsTop: Math.min(...controls.map(rect => rect.top)),
      wrapTop: wrap.getBoundingClientRect().top, wrapHeight: wrap.getBoundingClientRect().height,
      reserve: wrap.getAttribute("data-edge-reserve"),
      scrollReserve: scroll ? getComputedStyle(scroll).getPropertyValue("--composer-reserve") : null };
  });
  assert(geometry.head.top >= geometry.wrapTop - 1, "DS reserves the character within measured wrap");
  assert(geometry.textLines > 0, "real text glyph rectangles measured");
  assert(geometry.head.bottom <= geometry.textTop, "character does not overlap input text");
  assert(geometry.head.bottom <= geometry.controlsTop, "character does not overlap controls");
  return geometry;
}
async function startScreens() {
  for (const status of ["complete", "pending"]) {
    writeFileSync(join(server.butlerData, "personalization/onboarding.json"), JSON.stringify({
      schema: "butler.first_chat_onboarding.v1", status, gateway: "any", fields: {}, skipped_fields: [],
    }));
    for (const width of [1280, 375]) for (const theme of ["light", "dark"] as const) for (const language of ["ko", "en"] as const) {
      for (const wallpaper of ["none", "butler.bloom"]) {
        await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme,
          composer_decoration: { theme: before ? "none" : "shoreline", character: true },
          wallpaper: { source: wallpaper === "none" ? { kind: "none" } : { kind: "live", module: wallpaper }, motion: "paused" } }) });
        const briefing = await server.api<NewChatBriefingView>("/new-chat-briefing");
        assert.equal(briefing.source.scope, status === "pending" ? "onboarding" : "general");
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        if (page.url() !== "about:blank") await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        await page.goto(server.url);
        await page.getByRole("heading", { name: briefing.title, exact: true }).waitFor();
        await openEditor(page);
        await page.locator(editor).fill("Character geometry probe ".repeat(5));
        if (!before) { await firstFrame(page); await characterGeometry(page); }
        await capture(page, `${width}-${theme}-${language}-${status}-${wallpaper}`);
        if (!before && status === "complete" && wallpaper === "none") {
          await settings(page, language);
          await page.locator('[data-setting-id="composer-character"]').scrollIntoViewIfNeeded();
          await capture(page, `${width}-${theme}-${language}-settings-controls`);
        }
      }
    }
  }
  writeOnboardingComplete(server.butlerData);
}
async function scrollReserveScreens() {
  longReply = true;
  const scrollCases = [];
  for (const width of [1280, 375]) for (const theme of ["light", "dark"] as const) for (const language of ["ko", "en"] as const) {
    console.error(`Overflow transcript ${before ? "before" : "after"}: ${width}-${theme}-${language}`);
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme,
      composer_decoration: { theme: before ? "none" : "shoreline", character: true },
      wallpaper: { source: { kind: "none" }, motion: "paused" } }) });
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    if (page.url() !== "about:blank") await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(server.url); await openEditor(page);
    await page.locator(editor).fill("Long transcript reserve proof");
    await page.locator('[data-test-class="composer-send-button"]').click();
    await page.getByText(LAST_MESSAGE, { exact: true }).last().waitFor({ state: "attached" });
    const scroll = page.locator('[data-test-class~="conversation-scroll"]');
    await scroll.evaluate(element => element.scrollTo({ top: element.scrollHeight }));
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await page.getByText(LAST_MESSAGE, { exact: true }).last().waitFor();
    const transcript = await page.locator('[data-test-class~="message-list"]').innerText();
    for (let i = 1; i <= 60; i++) assert(transcript.includes(`Complete transcript paragraph ${i}.`), `paragraph ${i} retained`);
    const extent = await scroll.evaluate(e => ({ height: e.clientHeight, content: e.scrollHeight, offset: e.scrollTop,
      reserve: getComputedStyle(e).getPropertyValue("--composer-reserve") }));
    assert(extent.content > extent.height, "real overflowing transcript");
    assert(Math.abs(extent.content - extent.height - extent.offset) <= 1, "scrolled to actual bottom");
    if (!before) await firstFrame(page);
    const last = await page.getByText(LAST_MESSAGE, { exact: true }).last().boundingBox();
    const obstruction = await page.locator(before ? '[data-test-class="composer-card"]' : '[data-character="crab"]').first().boundingBox();
    assert(last && obstruction && last.y + last.height <= obstruction.y, "complete last message above composer and character");
    const key = `${width}-${theme}-${language}`;
    await capture(page, `${key}-overflow-transcript`);
    scrollCases.push({ key, paragraphs: 60, extent, lastBottom: last.y + last.height, obstructionTop: obstruction.y });
  }
  longReply = false;
  writeFileSync(join(out, "scroll-results.json"), JSON.stringify({ before, cases: scrollCases }, null, 2));
  console.log(JSON.stringify({ scrollCases }));
}
async function panelScreens() {
  for (const width of [1280, 375]) for (const theme of ["light", "dark"] as const) for (const language of ["ko", "en"] as const) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme,
      composer_decoration: { theme: before ? "none" : "shoreline", character: true }, wallpaper: { source: { kind: "none" } } }) });
    const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US");
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    if (page.url() !== "about:blank") await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(server.url); await openEditor(page);
    if (!before) await firstFrame(page);
    for (const mode of ["question", "authority"] as const) {
      toolMode = mode;
      toolPrompt = `Request ${mode} panel ${crypto.randomUUID()}`;
      await page.locator(editor).fill(toolPrompt);
      await page.locator('[data-test-class="composer-send-button"]').click();
      const panel = page.locator(mode === "question" ? '[data-slot="composer-question-panel"]' : '[data-test-class="composer-authority-decision"]');
      await panel.waitFor();
      assert.equal(await page.locator(scene).count(), 0);
      assert.equal(await page.locator('[data-character="crab"]').count(), 0);
      assert.equal(await page.locator("[data-edge-reserve]").count(), 0);
      await capture(page, `${width}-${theme}-${language}-${mode}-panel`);
      await panel.getByRole("button", { name: mode === "question" ? copy.interfaceDetails.questionPanel.skip : copy.interfaceDetails.deny, exact: true }).click();
      await openEditor(page);
      if (!before) await firstFrame(page);
    }
  }
}
async function runCase(width: number, theme: "light" | "dark", language: "en" | "ko") {
  const key = `${width}-${theme}-${language}`;
  console.error(`Composer decoration ${before ? "before" : "after"}: ${key}`);
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme,
    wallpaper: { source: { kind: "none" }, motion: "auto", pauseOnBattery: true },
    composer_decoration: { theme: "none", character: true } }) });
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "no-preference" });
  if (page.url() !== "about:blank") await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  try {
    await page.goto(server.url);
    await page.locator('[data-test-class="composer-card"]').waitFor();
    assert.equal(await page.locator(scene).count(), 0, "none never mounts decoration");
    await capture(page, `${key}-plain-none`);
    const plainTyping = await typing(page);
    const copy = await settings(page, language);
    await capture(page, `${key}-settings`);
    if (before) {
      await page.getByRole("button", { name: copy.settings.back, exact: true }).filter({ visible: true }).click();
      const back = page.getByRole("button", { name: copy.settings.back, exact: true }).filter({ visible: true });
      if (await back.count()) await back.click();
      await openEditor(page);
      await page.locator(editor).fill("Seed conversation");
      await page.locator(editor).press("ControlOrMeta+Enter");
      await page.getByText("Last complete message. This text must remain above the character and input.", { exact: false }).last().waitFor();
      await capture(page, `${key}-conversation-none`);
      await server.api("/settings", { method: "PATCH", body: JSON.stringify({ wallpaper: { source: { kind: "live", module: "butler.bloom" } } }) });
      await page.reload(); await capture(page, `${key}-wallpaper-none`);
      recordCase({ key, plainTyping }); return;
    }
    const group = page.getByRole("radiogroup", { name: copy.settings.fields.composerDecoration });
    assert.equal(await group.getByRole("radio").count(), 2, "cherry is not offered");
    let patches = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === "/settings" && request.method() === "PATCH") patches++; });
    await group.getByRole("radio", { name: copy.settings.wallpaper.none, exact: true }).click();
    await page.waitForTimeout(100); assert.equal(patches, 0, "unchanged theme sends no write");
    await group.getByRole("radio", { name: language === "ko" ? "해안선" : "Shoreline", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-setting-id="main-screen-motion"]'));
    await capture(page, `${key}-settings-shoreline`);
    await page.getByRole("button", { name: copy.settings.back, exact: true }).filter({ visible: true }).click();
    // On mobile, Back first returns to settings navigation.
    const back = page.getByRole("button", { name: copy.settings.back, exact: true }).filter({ visible: true });
    if (await back.count()) await back.click();
    await openEditor(page); await firstFrame(page);
    await page.locator(editor).fill("Character geometry probe ".repeat(5));
    const geometry = await characterGeometry(page);
    await capture(page, `${key}-plain-shoreline`);
    const decoratedTyping = await typing(page);
    await page.locator(editor).fill("Seed conversation");
    await page.locator(editor).press("ControlOrMeta+Enter");
    await page.getByText("Last complete message. This text must remain above the character and input.", { exact: false }).last().waitFor();
    await openEditor(page);
    await page.waitForTimeout(300);
    const message = page.getByText("Last complete message. This text must remain above the character and input.", { exact: false }).last();
    const lastBox = await message.boundingBox();
    const headBox = await page.locator('[data-character="crab"]').first().boundingBox();
    assert(lastBox && headBox && lastBox.y + lastBox.height <= headBox.y, "last message above character");
    await capture(page, `${key}-conversation-shoreline`);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(300); await resetDecorationProbe(page); await page.waitForTimeout(500);
    assert.equal((await readDecorationProbe(page)).draws, 0, "reduced motion freezes scene");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForTimeout(300); await resetDecorationProbe(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const taskDuration = async () => (await cdp.send("Performance.getMetrics")).metrics.find(m => m.name === "TaskDuration")!.value;
    const taskBefore = await taskDuration();
    await page.waitForTimeout(1000);
    const mainThreadMs = ((await taskDuration()) - taskBefore) * 1000;
    await cdp.detach();
    const frame = await readDecorationProbe(page);
    assert(frame.draws > 0, "auto motion resumes drawing");
    for (const mode of ["question", "authority"] as const) {
      console.error(`${key}: ${mode} panel`);
      toolMode = mode;
      toolPrompt = `Request ${mode} panel ${crypto.randomUUID()}`;
      await page.locator(editor).fill(toolPrompt);
      await page.locator(editor).press("ControlOrMeta+Enter");
      const panel = page.locator(mode === "question" ? '[data-slot="composer-question-panel"]' : '[data-test-class="composer-authority-decision"]');
      await panel.waitFor();
      assert.equal(await page.locator(scene).count(), 0, `${mode} hides decoration`);
      assert.equal(await page.locator('[data-character="crab"]').count(), 0, `${mode} hides character`);
      assert.equal(await page.locator("[data-edge-reserve]").count(), 0);
      await capture(page, `${key}-${mode}-panel`);
      await panel.getByRole("button", { name: mode === "question" ? copy.interfaceDetails.questionPanel.skip : copy.interfaceDetails.deny, exact: true }).click();
      await page.locator(scene).waitFor(); await openEditor(page); await firstFrame(page);
    }
    await settings(page, language);
    const characterSaved = page.waitForResponse(response => new URL(response.url()).pathname === "/settings" && response.request().method() === "PATCH");
    await page.locator('[data-setting-id="composer-character"]').getByRole("switch").click();
    assert.equal((await characterSaved).status(), 200);
    const saved = await server.api<SettingsView>("/settings");
    assert.equal(saved.composer_decoration.character, false);
    await page.reload(); await page.keyboard.press("Escape");
    await page.goto(server.url); await openEditor(page); await firstFrame(page);
    assert.equal(await page.locator('[data-character="crab"]').count(), 0);
    assert.equal(await page.locator("[data-edge-reserve]").count(), 0);
    await capture(page, `${key}-character-off`);
    const idleDbs = ["app-server/butler-client.sqlite", "agent-runtime/btcc.sqlite"].map(name => new Database(join(server.butlerData, name), { readonly: true }));
    const versions = () => idleDbs.map(db => db.query("PRAGMA data_version").get());
    const diskBefore = diskSnapshot(server.butlerData); const dbBefore = versions();
    await page.waitForTimeout(5000);
    const diskAfter = diskSnapshot(server.butlerData); const dbAfter = versions();
    idleDbs.forEach(db => db.close());
    assert.deepEqual(dbAfter, dbBefore, "idle database commits: zero");
    const changedFiles = Object.keys({ ...diskBefore, ...diskAfter }).filter(path => diskBefore[path] !== diskAfter[path]);
    assert.deepEqual(changedFiles, [], "idle disk writes: zero");
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ wallpaper: { source: { kind: "live", module: "butler.bloom" } }, composer_decoration: { theme: "shoreline", character: true } }) });
    await page.reload(); await openEditor(page); await firstFrame(page);
    await capture(page, `${key}-wallpaper-shoreline`);
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ composer_decoration: { theme: "none" } }) });
    await page.reload(); await openEditor(page);
    assert.equal(await page.locator(scene).count(), 0);
    await capture(page, `${key}-wallpaper-none`);
    recordCase({ key, plainTyping, decoratedTyping, geometry, frameSubmission: distribution(frame.drawMs),
      drawsPerSecond: frame.draws, mainThreadMsPerFrame: mainThreadMs / frame.draws, idleMs: 5000, idleDiskWrites: changedFiles.length, idleDatabaseCommits: 0 });
  } catch (error) { throw new Error(`${key}: ${String(error)}`, { cause: error }); }
}
try {
  const ids: string[] = [];
  for (let start = 0; start < 600; start += 10) {
    const rows = await Promise.all(Array.from({ length: 10 }, (_, i) => server.api<{ session: { id: string } }>("/sessions", {
      method: "POST", body: JSON.stringify({ kind: "chat", title: `Composer scale ${start + i}` }),
    })));
    ids.push(...rows.map(row => row.session.id));
  }
  const navigation = await server.api<{ chats: { id: string }[] }>("/navigation");
  const listed = new Set(navigation.chats.map(chat => chat.id));
  assert(ids.every(id => listed.has(id)), "all 600 owner-scale chat summaries retained");
  if (panelsOnly) await panelScreens();
  if (!scrollOnly && !startsOnly && !panelsOnly) {
    for (const width of [1280, 375]) for (const theme of ["light", "dark"] as const) for (const language of ["ko", "en"] as const) {
      await runCase(width, theme, language);
    }
    writeFileSync(join(out, "typing.json"), JSON.stringify(results, null, 2));
  }
  if (!startsOnly && !panelsOnly) await scrollReserveScreens();
  if (!scrollOnly && !panelsOnly) await startScreens();
  if (!scrollOnly && !startsOnly && !panelsOnly) writeFileSync(join(out, "results.json"), JSON.stringify({ before, cases: results, browser: browser.version(), ownerScaleChats: 600 }, null, 2));
  console.log(JSON.stringify({ before, cases: results }));
} catch (error) {
  console.error(String(error));
  await page.screenshot({ path: join(out, "failure.png") }).catch(() => undefined);
  throw error;
} finally {
  await page.goto("about:blank").catch(() => undefined);
  try { await browser.close(); } finally { await server.stop(); }
}
