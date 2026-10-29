// test-category: race
// Renderer replay on an isolated native gateway; headless Chromium, no live model calls.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page, Route } from "playwright";
import type { QueuedMessageRecord, SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { createNativeAppServer, nativeAgentExecutable } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { installSessionBrowser, installPendingAskEvents } from "../support/session-info-fixtures.ts";
import { probeFocusRingFrames } from "../support/focus-ring-clipping.ts";

const shots = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? join(process.env.TMPDIR ?? "/tmp", "butler-queued-send-now-shots"));
mkdirSync(shots, { recursive: true });
nativeAgentExecutable();
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;

function waiting(view: SessionView): QueuedMessageRecord[] {
  return ["첫 번째 후속 메시지", "두 번째 후속 메시지"].map((text, index) => ({
    id: `queue-${index}`, client_message_id: `client-${index}`, chat_id: view.session_id, text,
    state: "queued", cursor: index + 1, created_at: view.updated_at, updated_at: view.updated_at,
    controls: { model: "custom/stub", reasoning_effort: "none", access_mode: "ask_first", plan_mode: false },
  }));
}

async function emitDelivery(page: Page, sessionId: string) {
  await page.waitForFunction(() => Boolean((window as unknown as { __sessionInfoEventSources?: EventSource[] }).__sessionInfoEventSources?.length));
  await page.evaluate(sessionId => {
    const source = (window as unknown as { __sessionInfoEventSources: EventSource[] }).__sessionInfoEventSources.at(-1)!;
    source.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "turn.state_changed", payload: { session_id: sessionId, state: "cancelled" } }) }));
  }, sessionId);
}

async function prepare(page: Page, original: SessionView) {
  let view: SessionView = { ...original, messages: [{ id: "initial", chat_id: original.session_id, role: "user", text: "진행 중인 요청", created_at: original.updated_at }],
    latest_turn: { id: "running-turn", state: "running", cancellable: true, retryable: false,
      created_at: original.updated_at, updated_at: original.updated_at } };
  let queue = waiting(view);
  let posts = 0;
  let status = 200;
  let release: (() => void) | undefined;
  let completed: Promise<void> | undefined;
  const fulfill = (route: Route, data: unknown) => route.fulfill({ json: { protocol_version: "butler.app.v1", data } });
  await installSessionBrowser(page);
  await installPendingAskEvents(page);
  await page.route("**/session-view?**", route => fulfill(route, view));
  await page.route("**/session-queue?**", route => fulfill(route, { queued_messages: queue }));
  await page.route("**/session-queue/*/send-now", async route => {
    posts++;
    assert.equal(route.request().method(), "POST");
    assert.equal(new URL(route.request().url()).pathname, `/session-queue/${queue[0]!.id}/send-now`);
    assert.deepEqual(route.request().postDataJSON(), {});
    let finish!: () => void;
    completed = new Promise<void>(resolve => { finish = resolve; });
    await new Promise<void>(resolve => { release = resolve; });
    if (status === 200) await fulfill(route, { queued_messages: queue });
    else await route.fulfill({ status, json: { error: { code: status === 409 ? "queued_message_not_next" : "request_failed" } } });
    finish();
  });
  await page.addInitScript(id => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
    schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: true, right_open: false,
  })), original.session_id);
  await server.signIn(page);
  await page.goto(server.url);
  await page.locator('[data-test-class="queued-message"]').nth(1).waitFor();
  return {
    get posts() { return posts; },
    fail(code: number) { status = code; },
    async release() { assert(release); release(); await completed; release = undefined; },
    async deliver() {
      const first = queue[0]!;
      view = { ...view, messages: [...view.messages, { id: first.client_message_id!, chat_id: view.session_id,
        role: "user", text: first.text, status: "delivered", created_at: view.updated_at }],
        latest_turn: { ...view.latest_turn!, state: "cancelled", cancellable: false } };
      queue = queue.slice(1);
      await emitDelivery(page, view.session_id);
    },
  };
}

type Replay = Awaited<ReturnType<typeof prepare>>;
async function assertNoSendNowTooltip(page: Page, send: ReturnType<Page["getByRole"]>) {
  assert.equal(await send.getAttribute("aria-describedby"), null);
  await send.hover();
  await page.waitForTimeout(700);
  assert.equal(await page.getByRole("tooltip").count(), 0);
  assert.equal(await send.getAttribute("aria-describedby"), null);
  await page.mouse.move(0, 0);
  await send.focus();
  await page.waitForTimeout(700);
  assert.equal(await page.getByRole("tooltip").count(), 0);
  assert.equal(await send.getAttribute("aria-describedby"), null);
}

async function verifyFailure(page: Page, replay: Replay, status: number) {
  replay.fail(status);
  const first = page.locator('[data-test-class="queued-message"]').first();
  await first.getByRole("button", { name: "지금 보내기", exact: true }).click();
  await page.locator('[data-tone="sending"]').waitFor();
  const refreshed = page.waitForResponse(response => response.url().includes("/session-queue?") && response.ok());
  await replay.release();
  await refreshed;
  await page.locator('[data-test-class="queued-message"][data-tone="queued"]').nth(1).waitFor();
  assert.equal(await first.getByRole("button", { name: "지금 보내기", exact: true }).isEnabled(), true);
  const toast = page.getByText("보내지 못했습니다", { exact: true });
  if (status === 409) assert.equal(await toast.count(), 0);
  else await toast.waitFor();
}

async function verifyDelivery(page: Page, replay: Replay, capture: (name: string) => Promise<unknown>) {
  const rows = page.locator('[data-test-class="queued-message"]');
  const first = rows.first(), second = rows.nth(1);
  await second.getByText("대기 중 · 2개 중 2번째", { exact: true }).waitFor();
  assert.equal(await rows.getByRole("button", { name: "지금 보내기", exact: true }).count(), 1);
  assert.equal(await second.getByRole("button", { name: "지금 보내기", exact: true }).count(), 0);
  const send = first.getByRole("button", { name: "지금 보내기", exact: true });
  await assertNoSendNowTooltip(page, send);
  assert.deepEqual(await probeFocusRingFrames(page, () => send.focus()), []);
  await capture("queued");
  const posted = page.waitForRequest(request => request.url().endsWith("/send-now"));
  // Same event turn exercises the action guard before React can disable the control.
  await send.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await posted;
  await first.getByText("보내는 중…", { exact: true }).waitFor();
  assert.equal(await first.getAttribute("data-tone"), "sending");
  assert(await first.getByRole("button").evaluateAll(buttons => buttons.every(button => (button as HTMLButtonElement).disabled)));
  assert.equal(replay.posts, 1);
  await second.getByText("대기 중 · 2개 중 2번째", { exact: true }).waitFor();
  await capture("sending");
  await replay.release();
  assert.equal(await first.getAttribute("data-tone"), "sending", "Success retains sending until delivery");
  await replay.deliver();
  const delivered = page.locator('[data-test-class~="message"][data-test-class~="user"]').filter({ hasText: "첫 번째 후속 메시지" });
  await delivered.waitFor();
  assert.equal(await delivered.getAttribute("data-enter"), "delivered");
  assert.equal(await rows.count(), 1);
  await rows.getByText("두 번째 후속 메시지", { exact: true }).waitFor();
  await rows.getByText("대기 중", { exact: true }).waitFor();
  assert.equal(await rows.getByRole("button", { name: "지금 보내기", exact: true }).count(), 1);
  assert.equal(replay.posts, 1);
  await capture("delivered");
}

try {
  const { session } = await server.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "후속 메시지" }) });
  const view = await server.api<SessionView>(`/session-view?session_id=${session.id}`);
  browser = await launchSmokeBrowser();
  for (const theme of ["light", "dark"]) for (const wallpaper of [false, true]) for (const width of [1440, 390]) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme, reduce_motion: true,
      wallpaper: { source: wallpaper ? { kind: "live", module: "butler.riso-print" } : { kind: "none" }, motion: "paused", pauseOnBattery: false } }) });
    const page = await browser.newPage({ viewport: { width, height: 1050 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      const replay = await prepare(page, view);
      const capture = (name: string) => page.screenshot({ path: join(shots, `${theme}-${wallpaper ? "wallpaper" : "plain"}-${width}-${name}.png`), animations: "disabled" });
      await verifyDelivery(page, replay, capture);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ theme, wallpaper, width, posts: replay.posts, result: "RENDERER_REPLAY_PASS" }));
    } finally { await page.close(); }
  }
  for (const status of [409, 404, 503]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: "reduce" });
    try { await verifyFailure(page, await prepare(page, view), status); }
    finally { await page.close(); }
  }
  console.log(JSON.stringify({ result: "PASS", conditions: "headless Chromium; native gateway with HTTP replay; locked screen; no Electron or real-app verification", screenshots: shots }));
} finally {
  try { await browser?.close(); } finally { await server.stop(); }
}
