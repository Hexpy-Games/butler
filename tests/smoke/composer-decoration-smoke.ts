// Public settings -> real native gateway -> composer; stub providers only.
import { strict as assert } from "node:assert";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { distribution, installDecorationProbe, readDecorationProbe, resetDecorationProbe } from "../support/composer-decoration-probe";

const before = Bun.argv.includes("--before");
const out = resolve(`.tmp/composer-decoration/${before ? "before" : "after"}`);
mkdirSync(out, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve(before ? ".tmp/composer-before-dist" : "packages/butler-app/client/ui/dist"),
  stubReply: () => "Last complete message. This text must remain above the character and input." });
const browser = await launchSmokeBrowser();
const scene = '[data-test-class~="composer-decoration-scene"]';
const editor = '[contenteditable="true"]';
const results: unknown[] = [];

async function capture(page: Page, name: string) {
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
    const wrap = document.querySelector('[data-edge-reserve]')!;
    const head = wrap.querySelector('[data-character="crab"]')!.getBoundingClientRect();
    const text = document.querySelector('[contenteditable="true"]')!.getBoundingClientRect();
    const toolbar = document.querySelector('[data-slot="composer-toolbar"]')?.getBoundingClientRect();
    const scroll = document.querySelector('[data-test-class~="conversation-scroll"]');
    return { head: { top: head.top, bottom: head.bottom }, textTop: text.top, toolbarTop: toolbar?.top,
      wrapTop: wrap.getBoundingClientRect().top, wrapHeight: wrap.getBoundingClientRect().height,
      reserve: wrap.getAttribute("data-edge-reserve"),
      scrollReserve: scroll ? getComputedStyle(scroll).getPropertyValue("--composer-reserve") : null };
  });
  assert(geometry.head.top >= geometry.wrapTop - 1, "DS reserves the character within measured wrap");
  assert(geometry.head.bottom <= geometry.textTop, "character does not overlap input text");
  if (geometry.toolbarTop) assert(geometry.head.bottom <= geometry.toolbarTop);
  return geometry;
}
async function runCase(width: number, theme: "light" | "dark", language: "en" | "ko") {
  const key = `${width}-${theme}-${language}`;
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme,
    wallpaper: { source: { kind: "none" }, motion: "auto", pauseOnBattery: true },
    composer_decoration: { theme: "none", character: true } }) });
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
  try {
    await installDecorationProbe(page);
    await server.signIn(page); await page.goto(server.url);
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
      results.push({ key, plainTyping }); return;
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
    await page.waitForTimeout(300); await resetDecorationProbe(page); await page.waitForTimeout(1000);
    const frame = await readDecorationProbe(page);
    assert(frame.draws > 0, "auto motion resumes drawing");
    await settings(page, language);
    await page.locator('[data-setting-id="composer-character"]').getByRole("switch").click();
    await server.api("/settings").then((settings: any) => assert.equal((settings.data ?? settings).composer_decoration.character, false));
    await page.reload(); await page.keyboard.press("Escape");
    await page.goto(server.url); await openEditor(page); await firstFrame(page);
    assert.equal(await page.locator('[data-character="crab"]').count(), 0);
    assert.equal(await page.locator('[data-edge-reserve]').count(), 0);
    await capture(page, `${key}-character-off`);
    const idleDbs = ["app-server/butler-client.sqlite", "agent-runtime/btcc.sqlite"].map(name => new Database(join(server.butlerData, name), { readonly: true }));
    const versions = () => idleDbs.map(db => db.query("PRAGMA data_version").get());
    const diskBefore = diskSnapshot(server.butlerData); const dbBefore = versions();
    await page.waitForTimeout(1000);
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
    results.push({ key, plainTyping, decoratedTyping, geometry, frameSubmission: distribution(frame.drawMs),
      drawsPerSecond: frame.draws, idleMs: 1000, idleDiskWrites: changedFiles.length, idleDatabaseCommits: 0 });
  } finally { await page.close(); }
}
try {
  for (const width of [1280, 375]) for (const theme of ["light", "dark"] as const) for (const language of ["ko", "en"] as const) {
    await runCase(width, theme, language);
  }
  writeFileSync(join(out, "results.json"), JSON.stringify({ before, cases: results, browser: browser.version() }, null, 2));
  console.log(JSON.stringify({ before, cases: results }));
} finally { await browser.close(); await server.stop(); }
