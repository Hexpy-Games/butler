// test-category: race
// Real gateway events drive the chat status through two failed image calls and completion.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNativeAppServer, type StubModelRequest } from "../support/native-app-server";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";

if (await runSmokeCases(["light", "dark"], "BUTLER_IMAGE_FAILURE_CASE", import.meta.path, { isolate: true })) process.exit(0);
const theme = process.env.BUTLER_IMAGE_FAILURE_CASE ?? "light";
const before = Bun.argv.includes("--before");
const shots = process.env.BUTLER_IMAGE_FAILURE_SHOTS;
assert(shots, "Set BUTLER_IMAGE_FAILURE_SHOTS to a temp directory");
mkdirSync(shots, { recursive: true });
const conversation = (request: StubModelRequest) => request.stream && Array.isArray(request.body.tools) && request.body.tools.length > 0;
let round = 0;
let releaseModel: (() => void) | undefined;
let releaseImage: (() => void) | undefined;
let imageCalls = 0;
let modelWaiting = false;
let active = false;
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  await request.arrayBuffer();
  imageCalls++;
  await new Promise<void>(done => { releaseImage = done; });
  return Response.json({ error: { message: "Image service temporarily unavailable." } }, { status: 503 });
} });
const server = await createNativeAppServer({ uiRoot: process.env.BUTLER_IMAGE_FAILURE_UI_ROOT ?? resolve("packages/butler-app/client/ui/dist"),
  env: { OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, BUTLER_SECRET_STORE: "file", BUTLER_PLATFORM_SYSTEM_SECRETS: "0" },
  stubReply: async request => {
    if (!conversation(request) || !active) return "{}";
    if (round > 0) {
      modelWaiting = true;
      await new Promise<void>(done => { releaseModel = done; });
      modelWaiting = false;
    }
    return round === 2 ? "이미지를 만들지 못했습니다." : "그림을 만들겠습니다.";
  },
  stubToolCall: request => conversation(request) && active && round++ < 2
    ? { name: "generate_image", arguments: { prompt: "A small red kite" } } : null,
});
const browser = await launchSmokeBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
let sessionId: string | null = null;
page.on("request", request => {
  const url = new URL(request.url());
  if (url.pathname === "/session-view") sessionId = url.searchParams.get("session_id");
});
async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20_000;
  while (!await check()) { assert(Date.now() < deadline, label); await new Promise(done => setTimeout(done, 20)); }
}
async function capture(stage: string) {
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: join(shots!, `${before ? "before" : "after"}-${theme}-${width}-${stage}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", access_mode: "full_access", appearance_theme: theme,
    wallpaper: { source: { kind: "none" } } }) });
  const key = await server.api<{ credential: { id: string } }>("/credentials", { method: "POST", body: JSON.stringify({ provider_id: "openai", api_key: "image-stub-key" }) });
  await server.api("/settings/image-model", { method: "PUT", body: JSON.stringify({ model_ref: "openai/gpt-image-2.5-sunburst", credential_id: key.credential.id }) });
  await server.signIn(page);
  await page.goto(server.url);
  await page.locator('[data-test-class~="tree-row"][aria-label="대화"]').click();
  await waitFor(() => sessionId === "general", "general chat selected");
  const editor = page.locator('[contenteditable="true"]');
  await editor.waitFor(); active = true;
  await editor.fill("작은 연을 그려 주세요.");
  await page.locator('[data-test-class="composer-send-button"]').click();
  const label = page.locator('[data-test-class="turn-chat-activity"]');
  for (let call = 1; call <= 2; call++) {
    await waitFor(() => imageCalls === call, "image request dispatched");
    await label.filter({ hasText: "이미지" }).waitFor();
    await capture(`running-${call}`);
    releaseImage!();
    await waitFor(() => modelWaiting, "model receives failed image result");
    if (before) await label.filter({ hasText: "이미지" }).waitFor();
    else await label.waitFor({ state: "hidden" });
    await capture(`failed-${call}`);
    releaseModel!();
  }
  await page.getByText("이미지를 만들지 못했습니다.", { exact: true }).waitFor();
  await waitFor(async () => {
    assert(sessionId, "real chat session observed");
    const view = await server.api<{ latest_turn: { state: string } }>(`/session-view?session_id=${encodeURIComponent(sessionId)}`);
    return view.latest_turn.state === "delivered";
  }, "turn completion is durably projected");
  await page.locator('[data-test-class="turn-current-status-slot"]').waitFor({ state: "detached" });
  await capture("completed");
  assert.equal(imageCalls, 2);
  await page.reload();
  await page.getByText("이미지를 만들지 못했습니다.", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-test-class="turn-current-status-slot"]').count(), 0);
  console.log(JSON.stringify({ ok: true, before, theme, imageCalls, completedStatusCleared: true }));
} catch (error) {
  await page.screenshot({ path: join(shots, `failure-${before ? "before" : "after"}-${theme}.png`) });
  console.error({ sessionId, imageCalls, round, modelWaiting, page: await page.locator("body").innerText() });
  throw error;
} finally {
  releaseImage?.(); releaseModel?.();
  await page.goto("about:blank").catch(() => undefined);
  try { await browser.close(); } finally { await server.stop(); provider.stop(true); }
}
