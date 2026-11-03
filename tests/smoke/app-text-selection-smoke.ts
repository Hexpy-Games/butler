// Text selection through the real native App with a stub model only: a drag across App chrome (sidebar,
// titlebar, 세션 정보, composer toolbar) selects nothing; a drag inside a user message, an answer, a viewer document,
// viewer code and the composer selects. Light and dark; crops at deviceScaleFactor 2 into BUTLER_SMOKE_SCREENSHOTS.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Locator, Page } from "playwright";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { FILES, seedFileSession, withResults } from "../support/file-viewer-fixtures.ts";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { installSessionBrowser } from "../support/session-info-fixtures.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";

const cases = ["light", "dark"];
if (await runSmokeCases(cases, "BUTLER_TEXT_SELECTION_CASE", import.meta.path, { isolate: true })) process.exit(0);
const theme = process.env.BUTLER_TEXT_SELECTION_CASE ?? "light";
const shots = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? "/tmp/butler-text-selection-shots");
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

  for (const [name, target, line] of [
    ["sidebar", page.locator('[data-test-class="sidebar-scroll"]'), "diagonal"],
    ["titlebar", page.locator('[data-slot="titlebar-title"]').first(), "middle"],
    ["composer-toolbar", page.locator('[data-test-class="composer-toolbar"]'), "diagonal"],
  ] as const) {
    const { text } = await drag(page, target, name, line);
    assert.equal(text, "", `${name}: a drag over App chrome selects nothing`);
  }
  const infoToggle = page.locator('[data-test-class="session-info-toggle"]');
  await infoToggle.click();
  const aside = page.getByRole("complementary", { name: "세션 정보", exact: true });
  await aside.waitFor();
  const { text } = await drag(page, aside, "session-info", "diagonal");
  assert.equal(text, "", "session-info: a drag over App chrome selects nothing");

  const user = page.locator('[data-test-class="message-body"]').getByText("릴리스 노트와 코드를 검토해 줘", { exact: true });
  const answer = page.locator('[data-test-class="message-body"]').getByText("검토한 화면입니다.", { exact: true });
  for (const [name, target] of [["user-message", user], ["answer", answer]] as const) {
    const result = await drag(page, target, name, "middle");
    assert(result.inside && result.text.trim().length > 0, `${name}: a drag inside a message selects its text`);
  }

  await aside.locator('[data-slot="document-tile"]').getByText(FILES.markdown, { exact: true }).click();
  const viewer = page.locator('[data-slot="adaptive-shell-split-pane"] [data-test-class="file-viewer"]');
  await viewer.locator("h1").getByText("릴리스 노트", { exact: true }).waitFor();
  const documentResult = await drag(page, viewer.locator("h2").getByText("새 기능", { exact: true }), "viewer-document", "middle");
  assert(documentResult.inside && documentResult.text.includes("새 기능"), "viewer-document: a drag inside a document selects its text");
  await aside.locator('[data-slot="document-tile"]').getByText(FILES.code, { exact: true }).click();
  await viewer.locator("pre").getByText("shouldHandleShortcut", { exact: false }).waitFor();
  const codeResult = await drag(page, viewer.locator("pre"), "viewer-code", "middle");
  assert(codeResult.inside && codeResult.text.trim().length > 0, "viewer-code: a drag inside code selects its text");

  await infoToggle.click();
  await aside.waitFor({ state: "hidden" });
  // The composer is a Lexical contenteditable, so its selection is the document selection.
  const editor = page.locator('[data-test-class~="composer-card"] [contenteditable="true"]');
  await editor.fill("선택 확인 문장");
  await page.waitForFunction(() => document.querySelector('[data-test-class~="composer-card"]')?.getAnimations({ subtree: true })
    .every((animation) => animation.playState !== "running") ?? true);
  const composer = await drag(page, editor.getByText("선택 확인 문장", { exact: true }), "composer-input", "middle");
  assert(composer.inside && composer.text.includes("선택 확인 문장"), "a drag inside the composer selects its text");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "BEHAVIOR_PASS", theme, screenshots: shots }));
} finally {
  await browser?.close();
  await server.stop();
}

/** Drags across `target` (a horizontal line through its middle, or its diagonal), crops the region, then returns the selected text and whether the selection lies inside `target`. */
async function drag(page: Page, target: Locator, name: string, line: "middle" | "diagonal") {
  const box = (await target.boundingBox())!;
  const [start, end] = line === "diagonal"
    ? [{ x: box.x + 8, y: box.y + 8 }, { x: box.x + box.width - 8, y: box.y + box.height - 8 }]
    : [{ x: box.x + 2, y: box.y + box.height / 2 }, { x: box.x + box.width - 2, y: box.y + box.height / 2 }];
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
  const viewport = page.viewportSize()!;
  const x = Math.max(0, box.x - 24), y = Math.max(0, box.y - 24);
  await page.screenshot({ path: join(shots, `${name}-${theme}.png`), animations: "disabled",
    clip: { x, y, width: Math.min(viewport.width - x, box.width + 48), height: Math.min(viewport.height - y, box.height + 48) } });
  return target.evaluate((node) => {
    const selection = getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    return { text: selection?.toString() ?? "", inside: !!range && node.contains(range.commonAncestorContainer) };
  });
}
