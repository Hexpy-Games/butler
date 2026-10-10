// test-category: race
/** browser_wait_for_user hand-off through the real gateway and UI; stub model and a scripted
 * browser host. The user holds the tab for a secure field → hand-off card (no permission ask) →
 * Open tab → Give back to Butler → the call resumes; Stop task cancels. Desktop pages get a
 * recording browser bridge; the phone page has none. */
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer, type StubModelRequest } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";

const evidence = process.env.BUTLER_WAIT_HANDOFF_EVIDENCE; assert.ok(evidence, "BUTLER_WAIT_HANDOFF_EVIDENCE required");
mkdirSync(evidence, { recursive: true });
const TAB = "tab-wait-9c2e", CHECKOUT = "https://www.fixture-shop.test/checkout", ASK = "카드 번호 입력을 도와줘";
const FINAL = { ko: "결제 정보를 확인했습니다.", en: "Checked the payment details." };

// The model: describe, wait for the user on the secure field once per armed turn, then answer.
let armed = false, round = 0, language: "ko" | "en" = "ko";
const toolResults: string[] = [];
const decisions = new WeakMap<StubModelRequest, { text: string; tool: { name: string; arguments: Record<string, unknown> } | null }>();
function decide(request: StubModelRequest) {
  if (!request.stream) return { text: "{}", tool: null };
  let decision = decisions.get(request);
  if (decision) return decision;
  if (armed && round === 0) decision = { text: "", tool: { name: "tool_describe", arguments: { ids: ["native:browser_wait_for_user"] } } };
  else if (armed && round === 1) decision = { text: "", tool: { name: "tool_call", arguments: { id: "native:browser_wait_for_user", arguments: { tab: TAB, reason: "secure_field" } } } };
  else {
    toolResults.push(JSON.stringify(request.messages.filter(message => (message as { role?: string }).role === "tool").at(-1) ?? null));
    decision = { text: FINAL[language], tool: null }; armed = false;
  }
  round++; decisions.set(request, decision); return decision;
}
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_RENDERER_DIST ?? "packages/butler-app/client/ui/dist"),
  stubReply: async request => {
    // The conversation exists once the App sent the message: its tab (held by the user) precedes the call.
    if (request.stream && armed && round === 0 && !decisions.has(request)) await prepareSession();
    return decide(request).text;
  },
  stubToolCall: request => decide(request).tool });
const admin = () => (JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8")) as { secret: string }).secret;
const headers = () => ({ ...server.authHeaders, "x-butler-admin": admin(), "content-type": "application/json" });
async function internal(path: string, body?: unknown) {
  const response = await fetch(`${server.url}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const text = await response.text();
  assert.ok(response.ok, `POST ${path}: ${response.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as Record<string, any>;
}

// The browser host (main's part), scripted like main: tab.wait parks the tab while the user holds it.
let session = "";
const tab = { holder: "agent" as "agent" | "user", waiting: false, epoch: 1 };
const hostOps: string[] = [];
const publish = () => internal("internal/browser-host/events", { tabs: [{ id: TAB, owner: `conversation:${session}`, profile: "signed_out",
  epoch: tab.epoch, holder: tab.holder, waiting: tab.waiting, url: CHECKOUT }] });
async function answer(frame: Record<string, any>): Promise<Record<string, unknown>> {
  hostOps.push(frame.op);
  if (frame.op === "tab.wait") {
    tab.waiting = tab.holder === "user"; await publish(); await pushUi();
    return { status: tab.holder === "user" ? "user_control" : "ready", tab: TAB, epoch: tab.epoch };
  }
  if (frame.op === "tab.waiting") { tab.waiting = frame.args?.value === true; await publish(); await pushUi(); return { status: "ok" }; }
  return { status: "ok", tab: frame.tab, url: CHECKOUT };
}
const hostAbort = new AbortController();
const stream = await fetch(`${server.url}internal/browser-host`, { headers: headers(), signal: hostAbort.signal });
assert.equal(stream.status, 200);
const hostLoop = (async () => {
  const reader = stream.body!.getReader(); const decoder = new TextDecoder(); let buffer = "";
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const data = buffer.slice(0, end).split("\n").find(line => line.startsWith("data: "))?.slice(6); buffer = buffer.slice(end + 2);
      if (!data) continue;
      const frame = JSON.parse(data) as Record<string, any>;
      // Main's finishUse: the finished turn no longer waits on the tab.
      if (frame.op === "use.finished" && tab.waiting) { tab.waiting = false; void publish().then(pushUi); }
      if (String(frame.op).startsWith("use.")) continue;
      void answer(frame).then(result => internal(`internal/browser-host/results/${frame.id}`, result)).catch(error => console.error("host", error));
    }
  }
})();

// The App's browser bridge on desktop pages: records calls; the band's hand-back reaches the host.
const bridgeCalls: Array<{ op: string; input: unknown }> = [];
let pages: Page[] = [];
const uiSnapshot = () => ({ enabled: true, blocked: false, activeId: TAB, nativeCovered: false, tabs: [{ id: TAB, owner: `conversation:${session}`, url: CHECKOUT,
  title: "Fixture Shop", favicon: "", status: "idle", canBack: false, canForward: false, profile: "signed_out", agent: true,
  holder: tab.holder, waiting: tab.waiting, epoch: tab.epoch }] });
async function pushUi() { for (const page of pages) await page.evaluate(state => (window as any).__handoffPush?.(state), uiSnapshot()).catch(() => {}); }
async function bridgeCall(op: string, input: unknown) {
  bridgeCalls.push({ op, input });
  if (op === "control" && (input as { holder?: string }).holder === "agent") {
    Object.assign(tab, { holder: "agent", waiting: false, epoch: tab.epoch + 1 }); await publish(); await pushUi();
  }
  return ["state", "open"].includes(op) ? uiSnapshot() : op === "create" ? TAB : undefined;
}

const browser = await launchSmokeBrowser();
const shots: string[] = [];
let sessionSeen = "";
async function newPage(width: number, bridge: boolean) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  await server.signIn(page);
  page.on("request", request => { const url = new URL(request.url()); if (url.pathname === "/session-view") sessionSeen = url.searchParams.get("session_id") ?? sessionSeen; });
  if (bridge) {
    await page.exposeFunction("__handoffBridge", bridgeCall);
    await page.addInitScript(() => {
      const call = (window as any).__handoffBridge as (op: string, input?: unknown) => Promise<unknown>;
      const off = () => () => undefined;
      (window as any).butlerBrowser = { call, onPointer: off, onElementDrag: off, onSelectionAction: off, onAddress: off,
        subscribe: (handler: (state: unknown) => void) => { (window as any).__handoffPush = handler; void call("state").then(handler); return () => undefined; } };
    });
    pages.push(page);
  }
  return page;
}
async function prepareSession() {
  for (let i = 0; !sessionSeen && i < 100; i++) await new Promise(done => setTimeout(done, 100));
  session = sessionSeen; assert.ok(session, "conversation session observed");
  // The user took the tab over to type the card number.
  Object.assign(tab, { holder: "user", waiting: false, epoch: tab.epoch + 1 }); await publish(); await pushUi();
}
const card = (page: Page) => page.locator('[data-test-class="composer-browser-handoff"]');
async function settle(page: Page) { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(150); }
async function shoot(page: Page, name: string) { await settle(page); const path = join(evidence!, `${name}.png`); await page.screenshot({ path }); shots.push(path); }
const copy = {
  ko: { title: "직접 입력 필요", detail: "fixture-shop.test", inTab: "탭에서 마친 뒤 버틀러에게 돌려주세요", onDesktop: "데스크톱 앱에서 마무리해 주세요", open: "탭 열기", stop: "작업 중지", giveBack: "버틀러에게 돌려주기", status: "탭에서 마치기를 기다리고 있습니다.", band: "버틀러가 기다리는 중" },
  en: { title: "Your input needed", detail: "fixture-shop.test", inTab: "Finish in the tab, then give it back to Butler", onDesktop: "Finish in the desktop app", open: "Open tab", stop: "Stop task", giveBack: "Give back to Butler", status: "Waiting for you to finish in the tab.", band: "Butler is waiting" },
};
async function checkCard(page: Page, lang: "ko" | "en", desktop: boolean) {
  const panel = card(page); await panel.waitFor({ timeout: 30_000 });
  const text = await panel.innerText();
  for (const line of [copy[lang].title, copy[lang].detail, desktop ? copy[lang].inTab : copy[lang].onDesktop, copy[lang].stop]) assert.ok(text.includes(line), `${line} in ${text}`);
  assert.equal(text.includes(copy[lang].open), desktop, `open-tab button only with a browser: ${text}`);
  for (const absent of [TAB, "secure_field", "허용", "거절", "위험", "Allow", "Deny", "risk", "Steward", "스튜어드"]) assert.ok(!text.includes(absent), `${absent} must not be on the card: ${text}`);
  assert.equal(await page.locator('[data-test-class="composer-authority-decision"]').count(), 0, "the permission card is not used for a hand-off");
  await page.getByText(copy[lang].status, { exact: true }).waitFor();
}
async function send(page: Page, text: string) {
  const editor = page.locator('[contenteditable="true"]'); await editor.waitFor();
  await editor.fill(text); await page.locator('[data-test-class="composer-send-button"]').click();
}
async function settings(lang: "ko" | "en", theme: "light" | "dark") {
  language = lang;
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: lang, appearance_theme: theme }) });
}

try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: "light", access_mode: "full_access", wallpaper: { source: { kind: "none" } } }) });
  const desk = await newPage(1440, true);
  await desk.goto(server.url);
  await desk.locator('[contenteditable="true"]').waitFor();

  // 1. The user holds the tab for a secure field → hand-off card (no permission wording, no tab id, no raw reason).
  armed = true; round = 0;
  await send(desk, ASK);
  await checkCard(desk, "ko", true);
  assert.ok(hostOps.includes("tab.wait"), `wait dispatched: ${hostOps}`);

  // 2. Screenshots: desktop 1440/1100 with the browser, phone 375 without; light/dark; KO/EN.
  const phone = await newPage(375, false);
  for (const lang of ["ko", "en"] as const) for (const theme of ["light", "dark"] as const) {
    await settings(lang, theme);
    for (const width of [1440, 1100]) {
      await desk.setViewportSize({ width, height: 900 }); await desk.reload(); await checkCard(desk, lang, true);
      await shoot(desk, `wait-card-${lang}-${theme}-${width}`);
    }
    await phone.goto(server.url);
    await phone.getByRole("button", { name: lang === "ko" ? "사이드바 보기" : "Show sidebar", exact: true }).click();
    await phone.getByText(ASK, { exact: true }).first().click();
    await checkCard(phone, lang, false);
    await shoot(phone, `wait-card-${lang}-${theme}-375`);
  }
  await settings("ko", "light"); await desk.setViewportSize({ width: 1440, height: 900 }); await desk.reload(); await checkCard(desk, "ko", true);

  // 3. 탭 열기 opens and focuses the waiting tab; its band says Butler waits and offers the hand-back.
  bridgeCalls.length = 0;
  await card(desk).getByRole("button", { name: copy.ko.open, exact: true }).click();
  for (let i = 0; !bridgeCalls.some(c => c.op === "activate") && i < 50; i++) await desk.waitForTimeout(100);
  assert.ok(bridgeCalls.some(c => c.op === "activate" && (c.input as { id?: string }).id === TAB), `activate ${TAB}: ${JSON.stringify(bridgeCalls)}`);
  await desk.getByText(copy.ko.band, { exact: true }).waitFor();
  assert.equal(await desk.getByText("승인 대기", { exact: true }).count(), 0, "the band does not ask for approval");
  const giveBack = desk.getByRole("button", { name: copy.ko.giveBack, exact: true });
  await giveBack.waitFor();
  await shoot(desk, "wait-open-tab-ko-light-1440");

  // 4. 버틀러에게 돌려주기 → the card resolves and the call resumes.
  await giveBack.click();
  await desk.getByText(FINAL.ko, { exact: true }).waitFor({ timeout: 30_000 });
  await card(desk).waitFor({ state: "detached" });
  assert.ok(toolResults.at(-1)?.includes('\\"status\\":\\"ready\\"') || toolResults.at(-1)?.includes('"status":"ready"'), `resumed ready: ${toolResults.at(-1)}`);
  await shoot(desk, "wait-resumed-ko-light-1440");

  // 5. 작업 중지 on a second hand-off cancels the turn and clears the card.
  armed = true; round = 0;
  await send(desk, "다시 입력을 도와줘");
  await checkCard(desk, "ko", true);
  await card(desk).getByRole("button", { name: copy.ko.stop, exact: true }).click();
  await card(desk).waitFor({ state: "detached", timeout: 30_000 });
  const view = await server.api<{ latest_turn?: { state?: string } }>(`/session-view?session_id=${encodeURIComponent(session)}`);
  assert.equal(view.latest_turn?.state, "cancelled", JSON.stringify(view.latest_turn));
  await shoot(desk, "wait-stopped-ko-light-1440");
  console.log(JSON.stringify({ ok: true, screenshots: shots.length, bridge: bridgeCalls.map(c => c.op), hostOps: [...new Set(hostOps)], modelCalls: server.stubModelCalls.length }));
} catch (error) {
  for (const [index, page] of [...pages, ...browser.contexts().flatMap(context => context.pages())].entries()) await page.screenshot({ path: join(evidence, `failure-${index}.png`) }).catch(() => {});
  throw error;
} finally {
  writeFileSync(join(evidence, "agent.log"), server.diagnostics());
  hostAbort.abort(); await hostLoop.catch(() => {});
  pages = []; await browser.close(); await server.stop();
}
