// User-uploaded photos and an inline reply image through the native App, stub only.
import { createRequire } from "node:module";
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allowStubImages, drawPhoto, sendWithFiles, uploadFixture } from "../support/attachment-fixtures";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";

const requireUi = createRequire(new URL("../../packages/butler-app/client/ui/package.json", import.meta.url));
const { ViewIcon, ExpandIcon } = requireUi("@hugeicons/core-free-icons");

if (await runSmokeCases(["light", "dark"], "BUTLER_PHOTO_CASE", import.meta.path, { isolate: true })) process.exit(0);
const theme = process.env.BUTLER_PHOTO_CASE ?? "light";
assert(theme === "light" || theme === "dark");
const before = process.env.BUTLER_SMOKE_BASELINE === "1";
const shots = process.env.BUTLER_SMOKE_SCREENSHOTS;
let reply = "";
const server = await createNativeAppServer({ config: { user: { name: "Smoke", language: "ko" } }, stubReply: () => reply });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme }) });
  const config = JSON.parse(readFileSync(join(server.butlerData, "butler.config.json"), "utf8"));
  await allowStubImages(server, config.models.local[0].server_url);
  browser = await launchSmokeBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
  const photo = await drawPhoto(page, "사진.jpg", 800, 600, 200);
  const { session } = await server.api<{ session: { id: string } }>("/sessions", {
    method: "POST", body: JSON.stringify({ kind: "chat", title: "사진 확인" }),
  });
  const file = await uploadFixture(server, session.id, photo);
  // Echo the same stored photo as markdown: this is the path in the reported capture.
  reply = `![사진](${file.url})`;
  await sendWithFiles(server, session.id, "사진을 확인해 주세요", [file]);
  // Replay only the delivered reply's file reference, as a tool-produced image would carry it.
  // The upload, user message, turn and image bytes still use the real native server.
  const view = await server.api<{ messages: Array<{ role: string; attachments?: unknown[] }> }>(`/session-view?session_id=${session.id}`);
  for (const message of view.messages) {
    if (message.role === "assistant") message.attachments = [file];
  }
  await page.route("**/session-view?**", route => route.fulfill({ json: { protocol_version: "butler.app.v1", data: view } }));
  await server.signIn(page);
  await page.goto(server.url);
  const sidebar = page.locator('[data-test-class="app-sidebar"]');
  await sidebar.getByText("사진 확인", { exact: true }).click();
  const tile = page.locator('[data-test-class="message-attachment-list"] [data-slot="attachment-tile"]');
  const inline = page.locator('[data-test-class="message-image"]');
  await tile.waitFor();
  await inline.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-test-class="message-image"] img, [data-slot="attachment-tile"] img')]
    .every(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0));
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await inline.screenshot({ path: join(shots, `${before ? "before" : "after"}-${theme}-closeup.png`) });
  }
  const facts = await inline.evaluate(node => ({
    text: node.textContent,
    buttons: [...node.querySelectorAll("button, a")].map(button => ({ text: button.textContent, slot: button.getAttribute("data-slot") })),
    animations: node.getAnimations({ subtree: true }).map(animation => ({ name: (animation as CSSAnimation).animationName, state: animation.playState })),
    loaders: node.querySelectorAll('[data-slot="spinner"], [aria-busy="true"], [role="status"]').length,
  }));
  console.log(JSON.stringify({ theme, before, inline: facts }));
  assert.match(facts.text ?? "", /열기.*저장하기/u, "Both image actions remain visible");
  const open = inline.getByRole("button", { name: "열기: 사진.jpg", exact: true });
  const save = inline.getByRole("link", { name: /저장하기/u });
  assert.equal(await open.count(), 1);
  assert.equal(await save.count(), 1);
  const glyph = await open.locator("svg").evaluate(node => [...node.children].map(child => ({
    tag: child.tagName, attributes: Object.fromEntries([...child.attributes].filter(attr => attr.name !== "key").map(attr => [attr.name, attr.value])),
  })));
  const expected = (before ? ExpandIcon : ViewIcon).map(([tag, attributes]: [string, Record<string, unknown>]) => ({
    tag, attributes: Object.fromEntries(Object.entries(attributes).filter(([name]) => name !== "key").map(([name, value]) => [name.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`), String(value)])),
  }));
  assert.deepEqual(glyph, expected, before ? "Baseline Expand glyph" : "Open uses the Eye glyph, not Expand");
  assert.equal(facts.loaders, 0);
  assert.equal(await inline.evaluate(node => node.getAnimations({ subtree: true }).filter(animation =>
    (animation.effect as KeyframeEffect | null)?.getTiming().iterations === Infinity).length), 0, "No stuck loader animation");
  await tile.getByRole("button", { name: "사진.jpg", exact: true }).click();
  const viewer = page.locator('[data-slot="image-viewer"]');
  await viewer.locator("img").waitFor();
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  await inline.locator("img").click();
  await viewer.locator("img").waitFor();
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  await open.click();
  const artifactViewer = page.locator('[data-test-class="artifact-viewer"]');
  await artifactViewer.locator("img").waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-test-class="artifact-viewer"] img')]
    .some(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0));
  console.log(JSON.stringify({ result: "PASS", theme, photoTiles: await tile.count(), viewerOpens: 2, artifactViewerOpens: 1, stubModelCalls: server.stubModelCalls.length }));
} finally {
  await browser?.close();
  await server.stop();
}
