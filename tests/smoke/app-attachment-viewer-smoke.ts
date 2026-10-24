// Attachment tiles through the real App, stub model only. Electron (the preload link capture is live): a
// sent image tile opens the image viewer over the session, never a browser tab; Esc and ✕ close it with
// focus back on the tile; next pages to the second picture; a video plays there without autoplay; a PDF
// and an unknown file open in the session's inspector. A browser tab showing a CSP-sandboxed message file
// closes on ✕ and navigates away. Renderer cells (KO, light/dark, 1280/375) capture the composer, the sent
// tiles and the open viewer into BUTLER_SMOKE_SCREENSHOTS. BUTLER_SMOKE_BASELINE=1 captures the old UI
// (BUTLER_SMOKE_UI_ROOT) and reports how its attachment link and tab close behave; BUTLER_SMOKE_ELECTRON_ONLY=1
// skips the renderer cells.
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { appLocaleFromLanguage, getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { allowStubImages, drawPhoto, mixedFixtures, sendWithFiles, uploadFixture, type FixtureFile, type StoredFile } from "../support/attachment-fixtures.ts";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app.ts";
import { createNativeAppServer, type NativeAppServerHandle } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const shots = process.env.BUTLER_SMOKE_SCREENSHOTS;
const uiRoot = process.env.BUTLER_SMOKE_UI_ROOT;
const evidence = process.env.BUTLER_SMOKE_EVIDENCE ?? join(process.env.TMPDIR ?? "/tmp", "attachment-viewer-evidence");
process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE ??= createRequire(resolve("packages/butler-app/client/electron/package.json"))("electron") as string;
if (shots) mkdirSync(shots, { recursive: true });
const copy = getAppCopy(appLocaleFromLanguage("ko"));
const phase = baseline ? "before" : "after";
const title = "첨부 확인";
const tile = '[data-test-class="message-attachment-list"] [data-slot="attachment-tile"]';

async function seed(server: NativeAppServerHandle, fixtures: FixtureFile[]): Promise<{ sessionId: string; files: StoredFile[] }> {
  const config = JSON.parse(readFileSync(join(server.butlerData, "butler.config.json"), "utf8"));
  // The renderer cells' local stub model declares image input; the Electron App's vision stub already takes images.
  const local = config.models?.local?.[0];
  if (local) await allowStubImages(server, local.server_url);
  const sessionId = (await server.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title }) })).session.id;
  const files: StoredFile[] = [];
  for (const fixture of fixtures) files.push(await uploadFixture(server, sessionId, fixture));
  await sendWithFiles(server, sessionId, "이 파일들 확인해 줘", files);
  return { sessionId, files };
}

async function openSession(page: Page, name = title) {
  const show = page.getByRole("button", { name: copy.titlebar.showLeftPanel, exact: true });
  await show.or(page.getByRole("button", { name: copy.titlebar.hideLeftPanel, exact: true })).waitFor();
  if (await show.isVisible()) await show.click();
  await page.locator('[data-test-class="app-sidebar"]').getByText(name, { exact: true }).click();
  if (name === title) await page.locator('[data-test-class="message-attachment-list"]').waitFor();
}

/** Pictures decoded and videos at their first frame, so a capture shows what the user sees. */
async function settleMedia(page: Page) {
  await page.waitForFunction(() => [...document.querySelectorAll("img")].every((image) => image.complete)
    && [...document.querySelectorAll("video")].every((video) => video.readyState >= 1 || video.error));
  await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => done())))));
}

async function capture(page: Page, name: string) {
  if (shots) await page.screenshot({ path: join(shots, `${phase}-${name}.png`) });
}

/** Bytes the renderer fetched for the sent video's tile (first frame from metadata). */
function videoBytes(page: Page, video: StoredFile | undefined) {
  const sizes: Array<Promise<number>> = [];
  page.on("requestfinished", (request) => {
    if (video && request.url().includes(video.file_id)) sizes.push(request.sizes().then((size) => size.responseBodySize, () => 0));
  });
  return async () => (await Promise.all(sizes)).reduce((sum, size) => sum + size, 0);
}

async function rendererCell(browser: Browser, server: NativeAppServerHandle, fixtures: FixtureFile[], theme: "light" | "dark", width: number, video?: StoredFile) {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce", colorScheme: theme });
  const fetched = videoBytes(page, video);
  try {
    await server.signIn(page);
    await page.goto(server.url);
    await openSession(page);
    const composer = fixtures.filter((file) => !file.name.endsWith(".pdf")).slice(0, 5);
    const pending = baseline ? '[data-test-class~="composer-card"] [data-slot="attachment-item"]' : '[data-test-class~="composer-card"] [data-slot="attachment-tile"]';
    await page.setInputFiles("input[type='file']", composer.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })));
    await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length === count, { selector: pending, count: composer.length });
    // The composer shows its files while it is open (focused).
    const compact = page.locator('[data-slot="composer-compact-preview"]');
    if (await compact.isVisible()) await compact.click();
    await settleMedia(page);
    await capture(page, `session-${theme}-${width}`);
    if (baseline) return;
    if (video) console.log(`Video tile (${fixtures.find((file) => file.mimeType.startsWith("video/"))?.buffer.length} byte file): ${await fetched()} bytes fetched`);
    await page.locator(`${tile}[data-kind="image"] button`).first().click();
    await page.locator('[data-slot="image-viewer"] img').waitFor();
    await settleMedia(page);
    await capture(page, `viewer-${theme}-${width}`);
    await page.keyboard.press("Escape");
    await page.locator('[data-slot="image-viewer"]').waitFor({ state: "detached" });
  } finally { await page.close(); }
}

async function rendererCells(fixtures: FixtureFile[], browser: Browser, large: FixtureFile) {
  const server = await createNativeAppServer({ uiRoot, config: { user: { name: "Smoke", language: "ko" } } });
  try {
    const { sessionId, files } = await seed(server, fixtures);
    const video = files.find((file) => file.mime_type.startsWith("video/"));
    for (const theme of ["light", "dark"] as const) for (const width of [1280, 375]) {
      await rendererCell(browser, server, fixtures, theme, width, theme === "light" && width === 1280 ? video : undefined);
    }
    console.log(`Renderer cells (${phase}): KO light/dark, 1280/375 captured`);
    if (!baseline) await measureLargePicture(browser, server, sessionId, large);
    if (!baseline) await assertVideoDeferred(browser, server, fixtures);
  } finally { await server.stop(); }
}

type App = Awaited<ReturnType<typeof browserAgentApp>>;
const tabs = async (app: App) => (await app.call<{ tabs: Array<{ id: string; url: string; owner: string }> }>("state")).tabs;
const focusedTile = (app: App) => app.page.expression<string | null>("document.activeElement?.closest('[data-slot=attachment-tile]') ? document.activeElement.getAttribute('aria-label') : null");

/** A real pointer click (the preload's link capture sees it); a miss names what covers the target. */
async function click(app: App, selector: string) {
  try { await app.page.clickSelector(selector); } catch (error) {
    const cover = await app.page.expression<string>(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return "missing";
      const box = node.getBoundingClientRect(); const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return JSON.stringify({ box: [box.x, box.y, box.width, box.height], hit: hit?.outerHTML.slice(0, 200) }); })()`);
    throw new Error(`click ${selector}: ${cover}`, { cause: error });
  }
}

async function openElectronSession(app: App) {
  await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
  await waitBrowser(() => app.page.expression(`Boolean(document.querySelector('[data-test-class="app-sidebar"] [aria-label="${title}"]'))`), "session in the sidebar");
  await app.page.expression(`document.querySelector('[data-test-class="app-sidebar"] [aria-label="${title}"]').focus()`);
  await app.page.press("Enter");
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=\"message-attachment-list\"]'))"), "sent attachments");
}

async function assertViewer(app: App, files: StoredFile[]) {
  const [first, second] = files.filter((file) => file.kind === "image");
  const before = (await tabs(app)).length;
  await click(app, `${tile}[data-kind="image"] button[aria-label="${first!.safe_name}"]`);
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=\"image-viewer\"] img'))"), "image viewer open");
  assert.equal((await tabs(app)).length, before, "the image tile opened no browser tab");
  assert.equal(await app.page.expression("Boolean(document.querySelector('[data-test-class=\"browser-area\"]'))"), false, "the main view stays the session");
  await app.page.press("Escape");
  await waitBrowser(() => app.page.expression("!document.querySelector('[data-slot^=\"image-viewer\"]')"), "Esc closes the viewer");
  assert.equal(await focusedTile(app), first!.safe_name, "Esc returns focus to the tile");
  await click(app, `${tile}[data-kind="image"] button[aria-label="${first!.safe_name}"]`);
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=\"image-viewer\"] img'))"), "image viewer open again");
  await click(app, `[data-slot="image-viewer"] button[aria-label="${copy.conversation.imageViewer.next}"]`);
  await waitBrowser(() => app.page.expression(`document.querySelector('[data-slot="image-viewer"] img')?.alt === ${JSON.stringify(second!.safe_name)}`), "next shows the second picture");
  await click(app, `[data-slot="image-viewer"] button[aria-label="${copy.conversation.imageViewer.close}"]`);
  await waitBrowser(() => app.page.expression("!document.querySelector('[data-slot^=\"image-viewer\"]')"), "✕ closes the viewer");
  assert.equal(await focusedTile(app), first!.safe_name, "✕ returns focus to the tile");
  console.log("Image tile: viewer over the session, Esc/✕ close to the tile, next pages: passed");
}

async function assertVideoAndFiles(app: App, files: StoredFile[]) {
  const video = files.find((file) => file.mime_type.startsWith("video/"))!;
  await click(app, `${tile}[data-kind="video"] button[aria-label="${video.safe_name}"]`);
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=\"image-viewer\"] video[controls]'))"), "video in the viewer");
  assert.deepEqual(await app.page.expression("(() => { const v = document.querySelector('[data-slot=\"image-viewer\"] video'); return { paused: v.paused, autoplay: v.autoplay, preload: v.preload }; })()"),
    { paused: true, autoplay: false, preload: "metadata" }, "the video waits for play");
  await app.page.press("Escape");
  await waitBrowser(() => app.page.expression("!document.querySelector('[data-slot^=\"image-viewer\"]')"), "video viewer closed");
  const before = (await tabs(app)).length;
  for (const name of [files.find((file) => file.safe_name.endsWith(".pdf"))!.safe_name, "LICENSE"]) {
    await click(app, `${tile} button[aria-label="${name}"]`);
    await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=\"artifact-viewer\"]'))"), `${name} in the inspector`);
  }
  await waitBrowser(() => app.page.expression(`document.querySelector('[data-test-class="artifact-viewer"]')?.textContent.includes(${JSON.stringify(copy.artifacts.unsupported)})`), "unknown file: unsupported state");
  assert.equal(await app.page.expression(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(copy.artifacts.save)})`), true, "unsupported state offers save");
  assert.equal((await tabs(app)).length, before, "files opened no browser tab");
  console.log("Video plays in the viewer without autoplay; PDF and unknown file open in the inspector: passed");
}

/** A tab on a sandboxed message file (scripts off) closes on ✕ and can navigate away. */
async function assertSandboxedTab(app: App, src: string, plainUrl: string) {
  assert.match(src, /^http:\/\/127\.0\.0\.1:\d+\/message-files\//u);
  const csp = (await fetch(src)).headers.get("content-security-policy");
  assert.equal(csp, "sandbox; default-src 'none'", "the message file is served sandboxed");
  const open = async () => {
    const known = new Set((await tabs(app)).map((tab) => tab.id));
    await app.call("open-link", { url: src });
    let id = "";
    await waitBrowser(async () => { id = (await tabs(app)).find((tab) => !known.has(tab.id))?.id ?? ""; return Boolean(id); }, "sandboxed tab created");
    await waitBrowser(() => app.main(`(() => { const t = globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}); return Boolean(t?.view && !t.view.webContents.isLoading() && t.view.webContents.getURL()); })()`), "sandboxed tab loaded");
    return id;
  };
  const closing = await open();
  const started = Date.now();
  const result = await app.call<{ status: string; reason?: string }>("close", { id: closing });
  const closeMs = Date.now() - started;
  console.log(`Sandboxed tab close: ${JSON.stringify(result)} in ${closeMs} ms`);
  const navigating = await open();
  await app.call("navigate", { id: navigating, value: plainUrl });
  const moved = await waitBrowser(async () => (await tabs(app)).find((tab) => tab.id === navigating)?.url === plainUrl, "navigates off the sandboxed tab").then(() => true, () => false);
  console.log(`Sandboxed tab navigation: ${moved ? "left the file" : "stayed on the file"}`);
  if (baseline) return;
  assert.equal(result.status, "ok", "a sandboxed tab closes on ✕");
  assert.equal((await tabs(app)).some((tab) => tab.id === closing), false, "the closed tab is gone");
  assert.ok(moved, "a sandboxed tab navigates away");
  await assertOwnerKeepsUnsavedPage(app, navigating, `${plainUrl}elsewhere`);
}

/**
 * A normal page whose onbeforeunload objects (unsaved state) keeps the owner's choice: "stay" keeps the tab
 * on ✕ and keeps the page on an address-bar navigation; "leave" then closes it.
 */
async function assertOwnerKeepsUnsavedPage(app: App, id: string, elsewhere: string) {
  const contents = `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}).view.webContents`;
  await waitBrowser(() => app.main(`!${contents}.isLoading()`), "plain page loaded");
  const page = await app.main<string>(`${contents}.getURL()`);
  await app.main(`${contents}.executeJavaScript("window.onbeforeunload = (event) => { event.preventDefault(); return 'unsaved'; }; true")`);
  const dialog = async () => (await app.call<{ tabs: Array<{ id: string; dialog?: { id: string; type: string } }> }>("state")).tabs.find((tab) => tab.id === id)?.dialog;
  const answer = async (accept: boolean) => {
    await waitBrowser(async () => Boolean(await dialog()), "the page asks first");
    await app.call("dialog", { id, dialog: (await dialog())!.id, accept });
    await waitBrowser(async () => !(await dialog()), "answered");
  };
  const closing = app.call<{ status: string }>("close", { id });
  await answer(false);
  assert.equal((await closing).status, "dialog_pending");
  assert.ok((await tabs(app)).some((tab) => tab.id === id), "stay on ✕ keeps the tab");
  await app.call("navigate", { id, value: elsewhere });
  await answer(false);
  assert.equal(await app.main(`${contents}.getURL()`), page, "stay on a navigation keeps the page");
  const leaving = app.call("close", { id });
  await answer(true);
  await leaving;
  await waitBrowser(async () => !(await tabs(app)).some((tab) => tab.id === id), "leave closes the tab");
  console.log("Page with unsaved state: stay keeps the tab on ✕ and the page on navigation; leave closes: passed");
}

/** An 8000×6000 JPEG in a 96px tile: the main thread's longest task and frame gap while it decodes. */
async function measureLargePicture(browser: Browser, server: NativeAppServerHandle, sessionId: string, large: FixtureFile) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await server.signIn(page);
    await page.goto(server.url);
    await openSession(page);
    await page.evaluate(() => {
      const state = window as unknown as { tileLong: number; tileGap: number; tileDone?: boolean };
      state.tileLong = 0; state.tileGap = 0;
      let last = performance.now();
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) state.tileLong = Math.max(state.tileLong, entry.duration); }).observe({ type: "longtask" });
      const tick = (now: number) => { state.tileGap = Math.max(state.tileGap, now - last); last = now; if (!state.tileDone) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const file = await uploadFixture(server, sessionId, large);
    const started = Date.now();
    await sendWithFiles(server, sessionId, "큰 사진", [file]);
    const image = page.locator(`${tile} button[aria-label="${large.name}"] img`);
    await image.waitFor({ state: "attached" });
    await page.waitForFunction((node) => Boolean((node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth), await image.elementHandle());
    const facts = await page.evaluate(() => {
      const state = window as unknown as { tileLong: number; tileGap: number; tileDone?: boolean };
      state.tileDone = true;
      return { long: Math.round(state.tileLong), gap: Math.round(state.tileGap) };
    });
    console.log(`Large picture (${large.buffer.length} bytes, 8000x6000) in a 96px tile: decoded ${Date.now() - started} ms after send; longest main-thread task ${facts.long} ms; longest frame gap ${facts.gap} ms`);
  } finally { await page.close(); }
}

/** The file server has no byte ranges: a video tile out of view (end of the composer row) fetches nothing until scrolled near. */
async function assertVideoDeferred(browser: Browser, server: NativeAppServerHandle, fixtures: FixtureFile[]) {
  const name = "영상 지연";
  await server.api("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: name }) });
  const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
  const videoResponses: string[] = [];
  page.on("response", (response) => { if ((response.headers()["content-type"] ?? "").startsWith("video/")) videoResponses.push(response.url()); });
  try {
    await server.signIn(page);
    await page.goto(server.url);
    await openSession(page, name);
    const others = fixtures.filter((file) => !file.mimeType.startsWith("video/"));
    const files = [...others, ...others.map((file) => ({ ...file, name: `2-${file.name}` })), fixtures.find((file) => file.mimeType.startsWith("video/"))!];
    await page.setInputFiles("input[type='file']", files.map(({ name: fileName, mimeType, buffer }) => ({ name: fileName, mimeType, buffer })));
    const row = '[data-test-class~="composer-card"] [data-layout="row"]';
    await page.waitForFunction((selector) => document.querySelectorAll(`${selector} [data-slot="attachment-tile"]`).length === 11, row);
    const compact = page.locator('[data-slot="composer-compact-preview"]');
    if (await compact.isVisible()) await compact.click();
    // Once the tiles in view have loaded, a stray video request would have been made too.
    await page.waitForFunction((selector) => {
      const view = document.querySelector(selector)!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLImageElement>(`${selector} img`)].every((image) => {
        const box = image.getBoundingClientRect();
        return image.complete || box.right <= view.left || box.left >= view.right;
      });
    }, row);
    assert.equal(videoResponses.length, 0, "a video tile out of view fetches nothing");
    assert.equal(await page.locator(`${row} [data-kind="video"] video`).count(), 0, "the out-of-view video tile shows its badge face only");
    await page.locator(row).evaluate((node) => { node.scrollLeft = node.scrollWidth; });
    await page.locator(`${row} [data-kind="video"] video`).waitFor({ state: "attached" });
    await waitBrowser(async () => videoResponses.length > 0, "the scrolled-in video tile loads");
    await page.waitForFunction((selector) => {
      const video = document.querySelector<HTMLVideoElement>(`${selector} [data-kind="video"] video`);
      return Boolean(video && (video.readyState >= 2 || video.error));
    }, row);
    assert.equal(videoResponses.length, 1, "scrolled near, the video tile loads its first frame once");
    console.log("Video tile out of view: no request; scrolled into view: one request: passed");
  } finally { await page.close(); }
}

async function rangeFacts(app: App) {
  const src = await app.page.expression<string>(`document.querySelector('${tile}[data-kind="video"] video')?.src ?? ""`);
  if (!src) return;
  const response = await fetch(src, { headers: { Range: "bytes=0-1023" } });
  const body = await response.arrayBuffer();
  console.log(`Range bytes=0-1023 on a message file: status ${response.status}, accept-ranges ${response.headers.get("accept-ranges")}, ${body.byteLength} bytes returned`);
}

async function electronChecks(fixtures: FixtureFile[]) {
  const plain = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<title>Plain</title><h1>Plain page</h1>", { headers: { "content-type": "text/html" } }) });
  const app = await browserAgentApp(evidence, () => null, uiRoot);
  try {
    const { files } = await seed(app.gateway, fixtures);
    await openElectronSession(app);
    // The image file's own URL: the old attachment link's target.
    const src = await app.page.expression<string>("document.querySelector('[data-test-class=\"message-attachment-list\"] img')?.src ?? document.querySelector('[data-test-class=\"message-attachment-list\"] a')?.href");
    if (!baseline) {
      await assertViewer(app, files);
      await assertVideoAndFiles(app, files);
      await rangeFacts(app);
    } else {
      await click(app, '[data-test-class="message-attachment-list"] a');
      const opened = await waitBrowser(async () => (await tabs(app)).some((tab) => tab.owner === "mine"), "old link opens a tab").then(() => true, () => false);
      console.log(`Old attachment link: ${opened ? "opened a full-area browser tab" : "opened no tab"}`);
    }
    await assertSandboxedTab(app, src, `http://127.0.0.1:${plain.port}/`);
  } catch (error) {
    writeFileSync(join(evidence, "failure.png"), await app.page.screenshot());
    throw error;
  } finally { await app.stop(); void plain.stop(true); }
}

let browser: Browser | undefined;
try {
  browser = await launchSmokeBrowser();
  const maker = await browser.newPage();
  await maker.goto("about:blank");
  const fixtures = await mixedFixtures(maker, "ko");
  const large = await drawPhoto(maker, "큰_사진.jpg", 8000, 6000, 120);
  await maker.close();
  if (process.env.BUTLER_SMOKE_ELECTRON_ONLY !== "1") await rendererCells(fixtures, browser, large);
  await electronChecks(fixtures);
  console.log(baseline ? "Attachment baseline captured" : "Attachment viewer smoke passed");
} finally { await browser?.close(); }
