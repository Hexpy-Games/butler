// test-category: race
// Real product editor and durable cards over an isolated native gateway and stub model.
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Locator, Page } from "playwright";
import { createNativeAppServer, type NativeAppServerHandle } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { auditTabOrder, formatClips } from "../support/focus-ring-clipping";

const before = Bun.argv.includes("--before");
const output = process.env.BUTLER_SCHEDULE_BROWSER_SHOTS ?? "/tmp/schedule-browser-crops";
mkdirSync(output, { recursive: true });
let mode: "create" | "edit" | "site" = "create";
let round = 99;
const server = await createNativeAppServer({
  uiRoot: resolve(process.env.BUTLER_SCHEDULE_UI_ROOT ?? "packages/butler-app/client/ui/dist"),
  config: { user: { name: "Smoke", language: "ko" } },
  stubReply: request => request.stream ? "요청하신 작업을 준비합니다." : "{}",
  stubToolCall: request => {
    if (!request.stream || !Array.isArray(request.body.tools) || request.body.tools.length === 0) return null;
    const tool = mode === "create" ? "create_automation" : mode === "edit" ? "update_automation" : "browser_open";
    const step = round++;
    if (step === 0) return { name: "list_skills", arguments: {} };
    if (step === 1) return { name: "tool_describe", arguments: { ids: [`native:${tool}`] } };
    if (step !== 2) return null;
    const flags = before ? {} : { browser_signin: true, browser_payment: false };
    const args = mode === "create" ? { title: "아침 계정 확인", prompt: "계정의 새 소식을 확인해 주세요.", schedule_type: "interval", interval_minutes: 60, ...flags }
      : mode === "edit" ? { id: "editor-schedule", title: "저녁 계정 확인", ...(before ? {} : { browser_signin: true, browser_payment: true }) }
        : { url: "https://account.example.com/", signed_in: true };
    return { name: "tool_call", arguments: { id: `native:${tool}`, arguments: args } };
  },
});
const browser = await launchSmokeBrowser();
const abort = new AbortController();
let host: Promise<void> | undefined;
const paths: string[] = [];
let stops = 0;

async function settled(overlay: Locator) {
  await overlay.waitFor({ state: "visible" });
  await overlay.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished));
    const opacity = getComputedStyle(element).opacity;
    if (opacity !== "1") throw new Error(`Overlay is still fading: ${opacity}`);
  });
}

async function captureUnion(page: Page, filename: string, regions: Locator[]) {
  const boxes = await Promise.all(regions.map(region => region.boundingBox()));
  const visible = boxes.map(box => { assert(box); return box; });
  const x = Math.floor(Math.min(...visible.map(box => box.x)));
  const y = Math.floor(Math.min(...visible.map(box => box.y)));
  const clip = { x, y,
    width: Math.ceil(Math.max(...visible.map(box => box.x + box.width))) - x,
    height: Math.ceil(Math.max(...visible.map(box => box.y + box.height))) - y };
  const path = join(output, filename);
  const png = await page.screenshot({ path, clip, scale: "device" });
  const pixels = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  assert.equal(pixels.width, clip.width * 2, `${filename}: 2x CSS width`);
  assert.equal(pixels.height, clip.height * 2, `${filename}: 2x CSS height`);
  console.log(JSON.stringify({ crop: filename, css: clip, pixels }));
  paths.push(path);
}

async function capture(page: Page, name: string, selector: string, overlay?: Locator) {
  await page.bringToFront();
  assert.equal(await page.evaluate(() => document.hidden), false, "capture page stays frontmost");
  await page.evaluate(() => document.fonts.ready);
  const region = !before && selector.includes("automation-detail-view")
    ? page.getByRole("heading", { name: "브라우저", exact: true }).locator("xpath=ancestor::section[1]")
    : page.locator(selector).first();
  if (!overlay) await region.scrollIntoViewIfNeeded();
  if (name.includes("-card-")) {
    assert.deepEqual(await page.locator('[role="menu"]:visible, [data-slot="dropdown-menu-content"]:visible, [data-slot="popover-content"]:visible').allTextContents(), [],
      `${name}: closed-state capture has no visible menu or popover`);
  }
  await captureUnion(page, `${before ? "before" : "after"}-${name}.png`, [region, ...(overlay ? [overlay] : [])]);
  if (!before && name.startsWith("editor-off")) {
    await captureUnion(page, `after-editor-layout-${name.slice("editor-off-".length)}.png`, [page.locator(selector).first()]);
  }
}

async function checkFocus(page: Page, selector: string) {
  const result = await auditTabOrder(page, { within: selector, maxStops: 80 });
  stops += result.stops;
  assert.equal(result.clipped.length, 0, formatClips(result.clipped));
}

async function attachHost(gateway: NativeAppServerHandle) {
  const credential = JSON.parse(readFileSync(join(gateway.butlerData, "app/runtime/auth/local-admin.json"), "utf8")) as { secret: string };
  const headers = { ...gateway.authHeaders, "x-butler-admin": credential.secret };
  const response = await fetch(`${gateway.url}/internal/browser-host`, { headers, signal: abort.signal });
  assert.equal(response.status, 200);
  host = (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!abort.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const part = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = part.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
        if (!data) continue;
        const frame = JSON.parse(data) as { id?: string; op?: string };
        if (!frame.id || frame.op?.startsWith("use.")) continue;
        await fetch(`${gateway.url}/internal/browser-host/results/${frame.id}`, { method: "POST", headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ status: "ok", tab: "account", url: "https://account.example.com/", profile: "signed_in", obs: "o1", text: "Account" }), signal: abort.signal });
      }
    }
  })().catch(error => { if (!abort.signal.aborted) throw error; });
}

try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", access_mode: "ask_first", wallpaper: { source: { kind: "none" } } }) });
  const created = await server.api<{ automation: { id: string } }>("/automations", { method: "POST", body: JSON.stringify({ id: "editor-schedule", title: "아침 계정 확인", prompt_body: "계정의 새 소식을 확인해 주세요.", target_session_id: "general", interval_seconds: 3600 }) });
  assert.equal(created.automation.id, "editor-schedule");
  for (const theme of ["light", "dark"]) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
      await server.signIn(context);
      const page = await context.newPage();
      let available = true;
      // Capability fixture only: the screen and all schedule reads/writes use the real gateway.
      await page.route("**/security/vault", async route => route.fulfill({ json: { data: { available, reveal_available: false, cards: [], profiles: [], purchase_sites: [] } } }));
      await page.goto(server.url);
      const scheduleNav = page.getByText("예약 작업", { exact: true }).first();
      await scheduleNav.waitFor({ state: "attached" });
      if (!await scheduleNav.isVisible()) await page.getByRole("button", { name: "사이드바 보기", exact: true }).click();
      await scheduleNav.click();
      if (width === 390) await page.getByRole("button", { name: "사이드바 숨기기", exact: true }).last().click();
      await page.locator('[data-slot="clickable"]').filter({ hasText: "아침 계정 확인" }).click();
      const editor = '[data-test-class="automation-detail-view"]';
      await page.locator(editor).waitFor();
      if (before) {
        await capture(page, `editor-${width}-${theme}`, editor);
      } else {
        const signin = page.getByRole("switch", { name: "로그인 정보 사용", exact: true });
        const payment = page.getByRole("switch", { name: "결제 정보 사용", exact: true });
        assert(!await signin.isChecked()); assert(!await payment.isChecked());
        await capture(page, `editor-off-${width}-${theme}`, editor);
        await signin.check(); await payment.check();
        const persisted = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/automations/editor-schedule");
        await page.getByRole("button", { name: "저장", exact: true }).click();
        assert((await persisted).ok());
        const saved = await server.api<{ automation: { browser_signin: boolean; browser_payment: boolean } }>("/automations/editor-schedule");
        assert(saved.automation.browser_signin && saved.automation.browser_payment);
        await capture(page, `editor-on-${width}-${theme}`, editor);
        await checkFocus(page, editor);
        available = false;
        await page.reload();
        const nav = page.getByText("예약 작업", { exact: true }).first();
        await nav.waitFor({ state: "attached" });
        if (!await nav.isVisible()) await page.getByRole("button", { name: "사이드바 보기", exact: true }).click();
        await nav.click();
        if (width === 390) await page.getByRole("button", { name: "사이드바 숨기기", exact: true }).last().click();
        await page.locator('[data-slot="clickable"]').filter({ hasText: "아침 계정 확인" }).click();
        await page.locator("#schedule-browser-payment:disabled").waitFor();
        assert(await payment.isDisabled()); assert(!await payment.isChecked()); assert(await signin.isEnabled());
        await page.getByRole("heading", { name: "브라우저", exact: true }).locator("xpath=ancestor::section[1]").scrollIntoViewIfNeeded();
        await page.bringToFront();
        assert.equal(await page.evaluate(() => document.hidden), false, "hover page stays frontmost");
        await payment.hover();
        const tooltip = page.getByRole("tooltip", { name: "이 컴퓨터에서 사용 불가", exact: true });
        await settled(tooltip);
        await capture(page, `editor-disabled-${width}-${theme}`, editor, tooltip);
        await signin.uncheck();
        const otherSaved = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/automations/editor-schedule");
        await page.getByRole("button", { name: "저장", exact: true }).click();
        assert((await otherSaved).ok());
        const retained = await server.api<{ automation: { browser_signin: boolean; browser_payment: boolean } }>("/automations/editor-schedule");
        assert.equal(retained.automation.browser_signin, false, "the other field is saved");
        assert.equal(retained.automation.browser_payment, true, "unavailable payment keeps its stored value after saving");
        assert(await payment.isDisabled()); assert(!await payment.isChecked());
        await server.api("/automations/editor-schedule", { method: "PATCH", body: JSON.stringify({ browser_signin: false, browser_payment: false }) });
      }
      await context.close();
    }
  }
  await attachHost(server);
  for (const theme of ["light", "dark"]) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
      await server.signIn(context);
      const page = await context.newPage();
      let sessionId = "general";
      page.on("request", request => {
        const url = new URL(request.url());
        if (url.pathname === "/session-view") sessionId = url.searchParams.get("session_id") ?? sessionId;
      });
      for (mode of ["create", "edit", "site"] as const) {
        // Each card gets a fresh conversation, without earlier denied-turn failures or toasts.
        const { session } = await server.api<{ session: { id: string } }>("/sessions", {
          method: "POST", body: JSON.stringify({ kind: "chat", title: `${mode} ${width} ${theme}` }),
        });
        await page.goto(server.url);
        await page.evaluate(id => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
          schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id,
          left_open: false, right_open: false,
        })), session.id);
        await page.reload();
        const editor = page.locator('[contenteditable="true"]').first();
        await editor.waitFor(); round = 0;
        await editor.fill(`${mode}: 예약 작업을 처리해 주세요.`);
        await page.locator('[data-test-class="composer-send-button"]').click();
        const panel = '[data-test-class="composer-authority-decision"]';
        await page.locator(panel).waitFor();
        // Use the persisted waiting scene: pending asks can arrive before the
        // assistant message is committed, leaving an initial user anchor cached.
        const pending = await server.api<{ requests: Array<{ source_turn_id: string }> }>(`/authority-requests?session_id=${encodeURIComponent(sessionId)}`);
        assert.equal(sessionId, session.id, "the fixture uses its fresh conversation");
        const sourceTurn = pending.requests[0]?.source_turn_id;
        assert(sourceTurn, `the card belongs to ${sessionId}`);
        const waitingDeadline = Date.now() + 20_000;
        for (;;) {
          const view = await server.api<{ turns: Array<{ id: string; state: string }> }>(`/turns?chat_id=${encodeURIComponent(sessionId)}`);
          if (view.turns.some(turn => turn.id === sourceTurn && turn.state === "waiting_for_form")) break;
          assert(Date.now() < waitingDeadline, "the approval turn did not settle");
          await new Promise(done => setTimeout(done, 25));
        }
        await page.reload();
        await page.locator(panel).waitFor();
        await page.waitForFunction(selector => document.querySelector(selector)?.closest("article")
          ?.getAttribute("data-test-class")?.split(" ").includes("assistant"), panel);
        if (!before && mode !== "site") {
          await page.locator(panel).getByText("로그인 정보 사용 · 켜짐", { exact: true }).waitFor();
          await page.locator(panel).getByText(`결제 정보 사용 · ${mode === "edit" ? "켜짐" : "꺼짐"}`, { exact: true }).waitFor();
        }
        if (!before && mode === "site") {
          // The waiting turn posts a persistent attention notification. Dismiss it
          // through its real close control before opening the approval menu.
          for (const toast of await page.locator("[data-sonner-toast]:visible").all()) {
            assert.notEqual(await toast.getAttribute("data-type"), "error", await toast.innerText());
            await toast.getByRole("button", { name: "Close toast", exact: true }).click();
            await toast.waitFor({ state: "hidden" });
          }
          await page.locator(panel).getByRole("button", { name: "이 대화에서 허용", exact: true }).waitFor();
          await page.locator(panel).getByRole("button", { name: "허용 범위 선택", exact: true }).click();
          const item = page.getByRole("menuitem", { name: /이 사이트는 항상 허용/u });
          await item.waitFor();
          const menu = page.getByRole("menu");
          await settled(menu);
          const bounds = await menu.boundingBox();
          assert(bounds);
          assert(bounds.x >= 8 && bounds.x + bounds.width <= width - 8, "menu respects viewport collision padding");
          assert.equal(await page.getByText(/this reply\. Retry to continue\.|답변 실패/u).count(), 0, "clean fixture turn");
          assert.deepEqual(await page.locator("[data-sonner-toast]:visible").allTextContents(), [], "no fixture toast");
          await capture(page, `site-menu-${width}-${theme}`, panel, menu);
          await page.keyboard.press("Escape");
          await menu.waitFor({ state: "detached" });
        }
        console.log(JSON.stringify({ mode, width, theme, scene: await page.locator(panel).evaluate(element => {
          const parent = element.closest("article");
          return { parent: parent?.getAttribute("data-test-class"), width: element.getBoundingClientRect().width,
            request: element.closest('[data-test-class="conversation-request"]')?.getAttribute("data-request-source-message") };
        }) }));
        await capture(page, `${mode}-card-${width}-${theme}`, panel);
        if (!before) await checkFocus(page, panel);
        const denied = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/deny"));
        await page.locator(panel).getByRole("button", { name: "거절", exact: true }).click();
        const response = await denied;
        assert(response.ok());
        const chat = new URL(response.url()).searchParams.get("session_id");
        assert(chat);
        await page.locator(panel).waitFor({ state: "hidden" });
        const deadline = Date.now() + 20_000;
        for (;;) {
          const view = await server.api<{ turns: Array<{ id: string; state: string }> }>(`/turns?chat_id=${encodeURIComponent(chat)}`);
          const turn = view.turns.find(turn => turn.id === sourceTurn);
          if (turn && ["delivered", "failed", "cancelled"].includes(turn.state)) break;
          assert(Date.now() < deadline, `denied turn did not finish: ${JSON.stringify({ mode, theme, width, chat, turn })}`);
          await new Promise(done => setTimeout(done, 25));
        }
        const schedules = await server.api<{ automations: unknown[] }>("/automations");
        assert.equal(schedules.automations.length, 1, "denial never creates a schedule");
        if (!before) {
          const unchanged = await server.api<{ automation: { browser_signin: boolean; browser_payment: boolean } }>("/automations/editor-schedule");
          assert.equal(unchanged.automation.browser_signin, false, "denial never enables sign-in");
          assert.equal(unchanged.automation.browser_payment, false, "denial never enables payment");
        }
      }
      await context.close();
    }
  }
  console.log(JSON.stringify({ crops: paths, focusStops: stops }));
} finally {
  abort.abort(); await host;
  await browser.close(); await server.stop();
}
