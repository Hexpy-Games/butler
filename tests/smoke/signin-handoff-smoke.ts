// test-category: race
/** Sign-in hand-off through the real gateway and UI; stub model, a scripted browser host and a
 * throwaway keychain (BUTLER_E2E_KEYCHAINS, never the user's). MFA → hand-off card → Open tab →
 * Give back to Butler → the call resumes; Stop task cancels. Desktop pages get a recording
 * browser bridge; the phone page has none. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer, type StubModelRequest } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";

const evidence = process.env.BUTLER_SIGNIN_HANDOFF_EVIDENCE; assert.ok(evidence, "BUTLER_SIGNIN_HANDOFF_EVIDENCE required");
const keychains = process.env.BUTLER_E2E_KEYCHAINS; assert.ok(keychains, "BUTLER_E2E_KEYCHAINS (a throwaway keychain folder) required");
mkdirSync(evidence, { recursive: true });
const TAB = "tab-handoff-7f3a", LOGIN = "https://login.fixture-shop.test/session", CANARY = "canary-pw-handoff-5c1";
const FINAL = { ko: "로그인을 마쳤습니다.", en: "Signed in." };
const agentHome = mkdtempSync(join(tmpdir(), "signin-handoff-home-"));
mkdirSync(join(agentHome, "Library"), { recursive: true }); mkdirSync(join(agentHome, ".codex"));
symlinkSync(keychains, join(agentHome, "Library/Keychains"));

// The model: describe, call browser_sign_in once per armed turn, then answer.
let armed = false, round = 0, language: "ko" | "en" = "ko";
const toolResults: string[] = [];
const decisions = new WeakMap<StubModelRequest, { text: string; tool: { name: string; arguments: Record<string, unknown> } | null }>();
function decide(request: StubModelRequest) {
  if (!request.stream) return { text: "{}", tool: null };
  let decision = decisions.get(request);
  if (decision) return decision;
  if (armed && round === 0) decision = { text: "", tool: { name: "tool_describe", arguments: { ids: ["native:browser_sign_in"] } } };
  else if (armed && round === 1) decision = { text: "", tool: { name: "tool_call", arguments: { id: "native:browser_sign_in", arguments: { tab: TAB } } } };
  else {
    toolResults.push(JSON.stringify(request.messages.filter(message => (message as { role?: string }).role === "tool").at(-1) ?? null));
    decision = { text: FINAL[language], tool: null }; armed = false;
  }
  round++; decisions.set(request, decision); return decision;
}
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_RENDERER_DIST ?? "packages/butler-app/client/ui/dist"),
  config: { secrets: { store: "system" } }, env: { HOME: agentHome },
  stubReply: async request => {
    // The conversation exists once the App sent the message: its tab and site grant precede the call.
    if (request.stream && armed && round === 0 && !decisions.has(request)) await prepareSession();
    return decide(request).text;
  },
  stubToolCall: request => decide(request).tool });
const admin = () => (JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8")) as { secret: string }).secret;
const headers = () => ({ ...server.authHeaders, "x-butler-admin": admin(), "content-type": "application/json" });
async function internal(path: string, body?: unknown, method = "POST") {
  const response = await fetch(`${server.url}${path}`, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as Record<string, any>;
}

// The browser host (main's part), scripted: the fill hands the MFA step to the user.
let session = "";
const tab = { holder: "agent" as "agent" | "user", waiting: false, signinStep: undefined as string | undefined, epoch: 1 };
const hostOps: string[] = [];
const publish = () => internal("internal/browser-host/events", { tabs: [{ id: TAB, owner: `conversation:${session}`, profile: "signed_in",
  epoch: tab.epoch, holder: tab.holder, waiting: tab.waiting, url: LOGIN, ...(tab.signinStep ? { signinStep: tab.signinStep } : {}) }] });
async function answer(frame: Record<string, any>): Promise<Record<string, unknown>> {
  hostOps.push(frame.op);
  if (frame.op === "signin.fill") {
    Object.assign(tab, { holder: "user", signinStep: "mfa", epoch: tab.epoch + 1 }); await publish(); await pushUi();
    return { status: "user_required", reason: "mfa", url: LOGIN };
  }
  if (frame.op === "tab.waiting") { tab.waiting = frame.args?.value === true; await publish(); await pushUi(); return { status: "ok" }; }
  return { status: "ok", tab: frame.tab, url: LOGIN };
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
      // Main's finishUse: the finished turn no longer waits on the sign-in step.
      if (frame.op === "use.finished" && tab.signinStep) { Object.assign(tab, { waiting: false, signinStep: undefined }); void publish().then(pushUi); }
      if (String(frame.op).startsWith("use.")) continue;
      void answer(frame).then(result => internal(`internal/browser-host/results/${frame.id}`, result)).catch(error => console.error("host", error));
    }
  }
})();

// The App's browser bridge on desktop pages: records calls; the band's hand-back reaches the host.
const bridgeCalls: Array<{ op: string; input: unknown }> = [];
let pages: Page[] = [];
const uiSnapshot = () => ({ enabled: true, blocked: false, activeId: TAB, nativeCovered: false, tabs: [{ id: TAB, owner: `conversation:${session}`, url: LOGIN,
  title: "Fixture Shop", favicon: "", status: "idle", canBack: false, canForward: false, profile: "signed_in", agent: true,
  holder: tab.holder, waiting: tab.waiting, epoch: tab.epoch, ...(tab.signinStep ? { signinStep: tab.signinStep } : {}) }] });
async function pushUi() { for (const page of pages) await page.evaluate(state => (window as any).__handoffPush?.(state), uiSnapshot()).catch(() => {}); }
async function bridgeCall(op: string, input: unknown) {
  bridgeCalls.push({ op, input });
  if (op === "control" && (input as { holder?: string }).holder === "agent") {
    Object.assign(tab, { holder: "agent", waiting: false, signinStep: undefined, epoch: tab.epoch + 1 }); await publish(); await pushUi();
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
  if (session && session === sessionSeen) return;
  session = sessionSeen; assert.ok(session, "conversation session observed");
  await publish();
  await internal("internal/browser/calls", { op: "signin.grant", session, tab: "", args: { site: "fixture-shop.test" } });
}
const card = (page: Page) => page.locator('[data-test-class="composer-browser-handoff"]');
async function settle(page: Page) { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(150); }
async function shoot(page: Page, name: string) { await settle(page); const path = join(evidence!, `${name}.png`); await page.screenshot({ path }); shots.push(path); }
const copy = {
  ko: { title: "로그인 확인 필요", detail: "fixture-shop.test · 2단계 인증", inTab: "탭에서 마친 뒤 버틀러에게 돌려주세요", onDesktop: "데스크톱 앱에서 마무리해 주세요", open: "탭 열기", stop: "작업 중지", giveBack: "버틀러에게 돌려주기" },
  en: { title: "Sign-in needs you", detail: "fixture-shop.test · Two-step verification", inTab: "Finish in the tab, then give it back to Butler", onDesktop: "Finish in the desktop app", open: "Open tab", stop: "Stop task", giveBack: "Give back to Butler" },
};
async function checkCard(page: Page, lang: "ko" | "en", desktop: boolean) {
  const panel = card(page); await panel.waitFor({ timeout: 30_000 });
  const text = await panel.innerText();
  for (const line of [copy[lang].title, copy[lang].detail, desktop ? copy[lang].inTab : copy[lang].onDesktop, copy[lang].stop]) assert.ok(text.includes(line), `${line} in ${text}`);
  assert.equal(text.includes(copy[lang].open), desktop, `open-tab button only with a browser: ${text}`);
  for (const absent of [TAB, "mfa", "허용", "거절", "위험", "Allow", "Deny", "risk", "Steward", "스튜어드"]) assert.ok(!text.includes(absent), `${absent} must not be on the card: ${text}`);
  assert.equal(await page.locator('[data-test-class="composer-authority-decision"]').count(), 0, "the permission card is not used for a hand-off");
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
  const added = await internal("security/signins", { origin: "https://login.fixture-shop.test", username: "owner@fixture.test", password: CANARY });
  const entry = String(added.data?.id ?? added.id); assert.ok(entry && entry !== "undefined", JSON.stringify(added));
  await internal(`security/signins/${entry}`, { policy: "always" }, "PATCH");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: "light", access_mode: "full_access", wallpaper: { source: { kind: "none" } } }) });
  const desk = await newPage(1440, true);
  await desk.goto(server.url);
  await desk.locator('[contenteditable="true"]').waitFor();

  // 1. MFA → hand-off card (no permission wording, no tab id, no raw step code).
  armed = true; round = 0;
  await send(desk, "쇼핑몰에 로그인해 줘");
  await checkCard(desk, "ko", true);
  await desk.getByText("로그인 확인을 기다리고 있습니다.", { exact: true }).waitFor();
  await desk.getByText("쇼핑몰에 로그인해 줘 · 로그인 확인 필요", { exact: true }).waitFor();
  assert.ok(hostOps.includes("signin.fill"), `fill dispatched: ${hostOps}`);

  // 2. Screenshots: desktop 1440/1100 with the browser, phone 375 without; light/dark; KO/EN.
  const phone = await newPage(375, false);
  for (const lang of ["ko", "en"] as const) for (const theme of ["light", "dark"] as const) {
    await settings(lang, theme);
    for (const width of [1440, 1100]) {
      await desk.setViewportSize({ width, height: 900 }); await desk.reload(); await checkCard(desk, lang, true);
      await shoot(desk, `card-${lang}-${theme}-${width}`);
    }
    await phone.goto(server.url);
    // A phone opens the conversation from the sidebar.
    await phone.getByRole("button", { name: lang === "ko" ? "사이드바 보기" : "Show sidebar", exact: true }).click();
    await phone.getByText("쇼핑몰에 로그인해 줘", { exact: true }).first().click();
    await checkCard(phone, lang, false);
    await shoot(phone, `card-${lang}-${theme}-375`);
  }
  await settings("ko", "light"); await desk.setViewportSize({ width: 1440, height: 900 }); await desk.reload(); await checkCard(desk, "ko", true);

  // 3. 탭 열기 opens and focuses the waiting tab; the tab band offers the hand-back.
  bridgeCalls.length = 0;
  await card(desk).getByRole("button", { name: copy.ko.open, exact: true }).click();
  for (let i = 0; !bridgeCalls.some(c => c.op === "activate") && i < 50; i++) await desk.waitForTimeout(100);
  assert.ok(bridgeCalls.some(c => c.op === "activate" && (c.input as { id?: string }).id === TAB), `activate ${TAB}: ${JSON.stringify(bridgeCalls)}`);
  const giveBack = desk.getByRole("button", { name: copy.ko.giveBack, exact: true });
  await giveBack.waitFor();
  await shoot(desk, "open-tab-ko-light-1440");

  // 4. 버틀러에게 돌려주기 → the card resolves and the call resumes with a fresh observation.
  await giveBack.click();
  await desk.getByText(FINAL.ko, { exact: true }).waitFor({ timeout: 30_000 });
  await card(desk).waitFor({ state: "detached" });
  assert.ok(toolResults.at(-1)?.includes('\\"status\\":\\"ready\\"') || toolResults.at(-1)?.includes('"status":"ready"'), `resumed ready: ${toolResults.at(-1)}`);
  await shoot(desk, "resumed-ko-light-1440");

  // 5. 작업 중지 on a second hand-off cancels the turn and clears the card.
  Object.assign(tab, { holder: "agent", waiting: false, signinStep: undefined }); await publish(); await pushUi();
  armed = true; round = 0;
  await send(desk, "다시 로그인해 줘");
  await checkCard(desk, "ko", true);
  await card(desk).getByRole("button", { name: copy.ko.stop, exact: true }).click();
  await card(desk).waitFor({ state: "detached", timeout: 30_000 });
  const view = await server.api<{ latest_turn?: { state?: string } }>(`/session-view?session_id=${encodeURIComponent(session)}`);
  assert.equal(view.latest_turn?.state, "cancelled", JSON.stringify(view.latest_turn));
  await desk.waitForFunction(title => !document.body.innerText.includes(title), copy.ko.title);
  await shoot(desk, "stopped-ko-light-1440");

  await internal(`security/signins/${entry}`, undefined, "DELETE");
  const leaked = [server.diagnostics(), JSON.stringify(toolResults)].some(text => text.includes(CANARY));
  assert.ok(!leaked, "canary leaked");
  console.log(JSON.stringify({ ok: true, screenshots: shots.length, bridge: bridgeCalls.map(c => c.op), hostOps: [...new Set(hostOps)], modelCalls: server.stubModelCalls.length }));
} catch (error) {
  for (const [index, page] of [...pages, ...browser.contexts().flatMap(context => context.pages())].entries()) await page.screenshot({ path: join(evidence, `failure-${index}.png`) }).catch(() => {});
  throw error;
} finally {
  writeFileSync(join(evidence, "agent.log"), server.diagnostics());
  hostAbort.abort(); await hostLoop.catch(() => {});
  pages = []; await browser.close(); await server.stop();
  rmSync(agentHome, { recursive: true, force: true });
}
