// The file viewer in the conversation's right slot, through the real native App with a stub model only.
// Files are uploaded to the isolated App and served by it; the session view is replayed with them as Butler's
// results and an answer showing the picture. Covers: a 결과물 from 세션 정보 docks the viewer (세션 정보 floats),
// a second file adds tabs, the browser toggle takes the slot with the viewer kept behind, '파일 보기' brings it
// back, the answer image's 열기 opens it, closing every file hides the toggle, no sideways overflow, a reading
// page of at most 760px 48px in, the reduced-motion path, and a phone (the viewer takes the workspace). Light and dark cells; screenshots at 1440 and 1024
// (deviceScaleFactor 2, full window plus the pane crop) into BUTLER_SMOKE_SCREENSHOTS.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Locator, Page } from "playwright";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { FILES, IMAGE_SIZE, headerLayout, seedFileSession, viewerGeometry, withResults } from "../support/file-viewer-fixtures.ts";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { verifyPaneToggleFill } from "../support/pane-toggle-fill.ts";
import { auditSessionInfoFocus, installSessionBrowser } from "../support/session-info-fixtures.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";

const cases = ["light", "dark"];
if (await runSmokeCases(cases, "BUTLER_FILE_VIEWER_CASE", import.meta.path, { isolate: true })) process.exit(0);
const theme = process.env.BUTLER_FILE_VIEWER_CASE ?? "light";
const shots = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? "/tmp/butler-file-viewer-shots");
mkdirSync(shots, { recursive: true });
const title = "릴리스 노트 검토";
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme }) });
  browser = await launchSmokeBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2, colorScheme: theme as "light" | "dark" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.status() >= 400) console.error("HTTP_FAILURE", response.status(), new URL(response.url()).pathname); });
  page.on("console", (message) => { if (message.type() === "error") console.error("RENDER_ERROR", message.text()); });
  const sessionId = await seedFileSession(server, page, title);
  const view = withResults(await server.api<SessionView>(`/session-view?session_id=${sessionId}`));
  await page.route("**/session-view?**", (route) => route.fulfill({ json: { protocol_version: "butler.app.v1", data: view } }));
  await installSessionBrowser(page);
  await page.addInitScript((id) => {
    if (!localStorage.getItem("butler:app-ui-state:v1")) localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
      schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: true, right_open: false,
    }));
  }, sessionId);
  await server.signIn(page);
  const loaded = page.waitForResponse((response) => response.url().includes("/session-view?") && response.ok());
  await page.goto(server.url);
  await loaded;
  await page.locator('[data-test-class~="conversation"]').waitFor();
  const capture = async (name: string) => {
    const file = `${name}-${theme}-${page.viewportSize()!.width}`;
    await page.screenshot({ path: join(shots, `${file}.png`), animations: "disabled" });
    const pane = page.locator('[data-slot="adaptive-shell-split-pane"]');
    if (await pane.count()) await pane.screenshot({ path: join(shots, `${file}-pane.png`), animations: "disabled" });
    const header = page.locator('[data-test-class="file-viewer-header"]');
    if (await header.count()) await header.screenshot({ path: join(shots, `${file}-header.png`), animations: "disabled" });
  };

  const split = page.locator('[data-slot="adaptive-shell-split-pane"]');
  const viewer = split.locator('[data-test-class="file-viewer"]');
  const fileToggle = page.locator('[data-test-class="titlebar-file-viewer-toggle"]');
  const browserToggle = page.locator('[data-test-class="titlebar-browser-toggle"]');
  const infoToggle = page.locator('[data-test-class="session-info-toggle"]');
  const aside = page.getByRole("complementary", { name: "세션 정보", exact: true });
  const tabs = viewer.locator('[data-test-class="file-viewer-tabs"] [role="tab"]');
  assert.equal(await fileToggle.count(), 0, "no '파일 보기' while no file is open");

  // A 결과물 from 세션 정보 docks the viewer in the right slot; 세션 정보 floats beside it.
  await infoToggle.click();
  await aside.waitFor();
  assert.equal(await aside.getAttribute("data-layout"), "docked");
  const slid = slotMotion(page);
  await aside.locator('[data-slot="document-tile"]').getByText(FILES.markdown, { exact: true }).click();
  await viewer.locator("h1").getByText("릴리스 노트", { exact: true }).waitFor();
  assert((await slid).includes("transform"), "the slot slides in");
  await page.waitForFunction(() => document.querySelector('[data-slot="conversation-aside"]')?.getAttribute("data-layout") === "floating");
  assert.equal(await aside.locator('[data-test-class="artifact-viewer"]').count(), 0, "nothing renders in the 세션 정보 pane");
  assert.equal(await page.locator('[data-test-class="browser-area"]').count(), 0, "the browser stays closed");
  assert.equal(await fileToggle.getAttribute("aria-pressed"), "true");
  assert.equal(await browserToggle.getAttribute("aria-pressed"), "false");
  const [fileBox, browserBox] = [await fileToggle.boundingBox(), await browserToggle.boundingBox()];
  assert(fileBox!.x < browserBox!.x, "'파일 보기' sits left of the browser toggle");
  assert.equal(await tabs.count(), 0, "one file has no tabs");
  // Size and age only: the stored kind ("document") is an internal value and never shows.
  await viewer.locator('[data-test-class="file-viewer-header"]').getByText(/^\d+(\.\d)? (B|KB) · 지금$/u).waitFor();
  assert.equal(await viewer.locator('[data-test-class="file-viewer-header"]').getByText(/document/u).count(), 0);
  await verifyHeader(viewer, "markdown", { compact: false, library: true });
  await verifyGeometry(viewer, "markdown");
  await infoToggle.click();
  await aside.waitFor({ state: "hidden" });
  // '파일 보기' fills with the viewer card's surface while the viewer holds the slot (IconButton pane="viewer").
  const fills = [await verifyPaneToggleFill(page, "viewer", true), await verifyPaneToggleFill(page, "browser", false)];
  await capture("markdown");

  // A second file adds file tabs; code reads in monospace.
  await infoToggle.click();
  await aside.locator('[data-slot="document-tile"]').getByText(FILES.code, { exact: true }).click();
  await viewer.locator("pre").getByText("shouldHandleShortcut", { exact: false }).waitFor();
  assert.equal(await tabs.count(), 2);
  assert.match(await viewer.locator("pre").evaluate((node) => getComputedStyle(node).fontFamily), /Plex Mono/u);
  await infoToggle.click();
  await aside.waitFor({ state: "hidden" });
  await verifyGeometry(viewer, "code");
  await capture("code");
  await tabs.filter({ hasText: FILES.markdown }).click();
  await viewer.locator("h1").getByText("릴리스 노트", { exact: true }).waitFor();
  await capture("two-tabs");
  const focus = await auditSessionInfoFocus(page, viewer);
  console.log(JSON.stringify({ viewerFocusStops: focus.stops, clipped: focus.clips.length }));
  assert.deepEqual(focus.clips, [], "focus rings in the viewer are never clipped");

  // The browser takes the slot; the viewer stays open behind it and '파일 보기' brings it back.
  await capture("switch-before");
  await browserToggle.click();
  await split.locator('[data-test-class="browser-area"]').waitFor();
  await viewer.waitFor({ state: "detached" });
  assert.equal(await browserToggle.getAttribute("aria-pressed"), "true");
  assert.equal(await fileToggle.getAttribute("aria-pressed"), "false", "the files stay open behind the browser");
  fills.push(await verifyPaneToggleFill(page, "browser", true), await verifyPaneToggleFill(page, "viewer", false));
  console.log(JSON.stringify({ paneToggleFills: fills.map(({ pane, pressed, fill }) => ({ pane, pressed, fill })) }));
  await capture("switch-browser");
  await fileToggle.click();
  await viewer.locator("h1").getByText("릴리스 노트", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-test-class="browser-area"]').count(), 0);
  assert.equal(await tabs.count(), 2, "both files are still open");
  assert.equal(await browserToggle.getAttribute("aria-pressed"), "false");
  await capture("switch-after");

  // The answer image's 열기 opens the picture in the viewer, frameless at its natural size.
  await page.locator('[data-test-class="message-image-open"]').click();
  const image = viewer.locator('[data-test-class="artifact-viewer"] img');
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-test-class="file-viewer"] [data-test-class="artifact-viewer"] img');
    return node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0;
  });
  assert.equal(await tabs.count(), 3);
  const size = await image.evaluate((node: HTMLImageElement) => ({ width: node.getBoundingClientRect().width, natural: node.naturalWidth, border: getComputedStyle(node).borderTopWidth }));
  assert.deepEqual(size, { width: IMAGE_SIZE.width, natural: IMAGE_SIZE.width, border: "0px" });
  await verifyGeometry(viewer, "image");
  await verifyHeader(viewer, "image", { compact: false, library: false });
  await capture("image");

  await page.setViewportSize({ width: 1024, height: 768 });
  await tabs.filter({ hasText: FILES.markdown }).click();
  await viewer.locator("h1").getByText("릴리스 노트", { exact: true }).waitFor();
  await verifyGeometry(viewer, "markdown-1024");
  await verifyHeader(viewer, "markdown-1024", { compact: false, library: true });
  await capture("markdown");
  await page.setViewportSize({ width: 1440, height: 960 });

  // 서랍에서 열기 opens the 서랍's 문서 searched to this file; the conversation keeps its open files.
  await viewer.locator('[data-test-class="file-viewer-open-in-library"]').click();
  await page.locator('[data-test-class="library-toolbar"] input').waitFor();
  assert.equal(await page.locator('[data-test-class="library-toolbar"] input').inputValue(), FILES.markdown);
  assert.equal(await page.evaluate(() => document.querySelector('[data-test-class="file-viewer"]') === null), true);
  await page.locator('[data-test-class="app-sidebar"]').getByText(title, { exact: true }).click();
  await viewer.locator("h1").getByText("릴리스 노트", { exact: true }).waitFor();
  assert.equal(await tabs.count(), 3, "the files stay open across the 서랍 visit");

  // Closing every file hides '파일 보기'; the browser, still open, takes the slot back.
  const close = viewer.locator('[data-test-class="file-viewer-close"]');
  await close.click();
  await page.waitForFunction(() => document.querySelectorAll('[data-test-class="file-viewer-tabs"] [role="tab"]').length === 2);
  await close.click();
  await page.waitForFunction(() => document.querySelector('[data-test-class="file-viewer"]') && !document.querySelector('[data-test-class="file-viewer-tabs"]'));
  await close.click();
  await viewer.waitFor({ state: "detached" });
  await fileToggle.waitFor({ state: "detached" });
  await split.locator('[data-test-class="browser-area"]').waitFor();
  assert.equal(await browserToggle.getAttribute("aria-pressed"), "true");
  await browserToggle.click();
  await split.waitFor({ state: "detached" });

  // Reduced motion: the slot fades in without travel.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await infoToggle.click();
  const faded = slotMotion(page);
  await aside.locator('[data-slot="document-tile"]').getByText(FILES.code, { exact: true }).click();
  await viewer.locator("pre").waitFor();
  const reduced = await faded;
  assert(reduced.includes("opacity") && !reduced.includes("transform"), `reduced motion fades the slot in: ${reduced}`);
  await viewer.locator('[data-test-class="file-viewer-close"]').click();
  await split.waitFor({ state: "detached" });

  // A phone has no room beside the chat: the viewer takes the workspace. 세션 정보 has nothing to show beside it,
  // so its toggle leaves; the back button returns to the chat with the files still open behind '파일 보기'.
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneViewer = page.locator('[data-test-class="file-viewer"]');
  // click() scrolls the (virtualized) transcript row into view and re-resolves it if the row remounts on the way.
  await page.locator('[data-test-class="message-image-open"]').click();
  await phoneViewer.locator('[data-test-class="artifact-viewer"] img').waitFor();
  assert.equal(await page.locator('[data-test-class~="conversation"]').count(), 0, "the viewer replaces the chat on a phone");
  assert.equal(await infoToggle.count(), 0, "no 세션 정보 toggle while the viewer holds the phone workspace");
  assert.equal(await fileToggle.getAttribute("aria-pressed"), "true");
  await verifyGeometry(phoneViewer, "phone");
  await verifyHeader(phoneViewer, "phone-image", { compact: true, library: false });
  await capture("phone");
  await phoneViewer.locator('[data-test-class="file-viewer-back"]').click();
  await page.locator('[data-test-class~="conversation"]').waitFor();
  await infoToggle.waitFor();
  assert.equal(await fileToggle.getAttribute("aria-pressed"), "false", "back keeps the file open behind '파일 보기'");
  await fileToggle.click();
  await phoneViewer.locator('[data-test-class="artifact-viewer"] img').waitFor();
  assert.equal(await infoToggle.count(), 0, "the 세션 정보 toggle leaves again with the viewer");
  await phoneViewer.locator('[data-test-class="file-viewer-close"]').click();
  await page.locator('[data-test-class~="conversation"]').waitFor();

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "BEHAVIOR_PASS", theme, screenshots: shots, reducedAnimation: reduced, stubModelCalls: server.stubModelCalls.length }));
} finally {
  await browser?.close();
  await server.stop();
}

/** The properties the right slot animates on its first frame, as it mounts. */
function slotMotion(page: Page) {
  return page.evaluate(() => new Promise<string[]>((resolve) => {
    const tick = () => {
      const slot = document.querySelector('[data-slot="adaptive-shell-split-pane"]');
      if (!slot) { requestAnimationFrame(tick); return; }
      resolve(slot.getAnimations().flatMap((animation) => (animation.effect as KeyframeEffect).getKeyframes().flatMap((frame) => Object.keys(frame))));
    };
    tick();
  }));
}

async function verifyGeometry(viewer: Locator, name: string) {
  const page: Page = viewer.page();
  await page.waitForFunction(() => document.querySelector('[data-slot="adaptive-shell-split-pane"]')?.getAnimations({ subtree: true })
    .every((animation) => animation.playState !== "running") ?? true);
  const geometry = await viewerGeometry(viewer);
  console.log(JSON.stringify({ geometry: name, width: page.viewportSize()!.width, ...geometry }));
  assert(geometry.overflow <= 0 && geometry.contentPastCard === 0, `${name}: no sideways overflow (${geometry.overflow}px)`);
  assert(geometry.pageWidth <= 760, `${name}: reading page ≤760px (${geometry.pageWidth}px)`);
  assert(geometry.insetStart >= 48 && geometry.insetEnd >= 48, `${name}: 48px insets (${geometry.insetStart}/${geometry.insetEnd})`);
  assert.equal(geometry.innerScrolls, 0, `${name}: no inner scroll`);
}

async function verifyHeader(viewer: Locator, name: string, expected: { compact: boolean; library: boolean }) {
  const header = await headerLayout(viewer);
  console.log(JSON.stringify({ header: name, ...header }));
  assert.equal(header.compact, expected.compact, `${name}: ${expected.compact ? "icon" : "labelled"} actions`);
  assert.deepEqual(header.offRow, [], `${name}: name, actions and close share one row`);
  assert.equal(header.outside, 0, `${name}: no action past the header`);
  assert(header.lastIsClose, `${name}: close comes last`);
  assert.equal(header.unnamed, 0, `${name}: every action has an accessible name`);
  if (expected.compact) assert.equal(header.iconOnly, header.labels.length, `${name}: icon-only actions`);
  assert.equal(header.labels.some((label) => label?.startsWith("서랍에서 열기")), expected.library, `${name}: 서랍에서 열기 only for a delivered file`);
}
