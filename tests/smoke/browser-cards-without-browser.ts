// test-category: race
/** Offline gateway replay through the real conversation, decision commands and attention toast. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import type { Page } from "playwright";
import { HARNESS_MESSAGES, HARNESS_NAVIGATION, HARNESS_SS03_OBSERVER_VIEW } from "../../packages/butler-app/client/ui/src/app/fixtures";
import { getAppCopy } from "../../packages/butler-i18n/src/index";
import { launchSmokeBrowser } from "../support/smoke-browser";

const output = process.env.BUTLER_BROWSER_EVIDENCE;
assert(output, "BUTLER_BROWSER_EVIDENCE required");
mkdirSync(output, { recursive: true });
const before = process.argv.includes("--before");
const dist = resolve("packages/butler-app/client/ui/dist");
const base = "http://browser-cards.localhost/";
const browser = await launchSmokeBrowser();
const errors: string[] = [];
const commands: string[] = [];
const session = "butler-client";
let requests: unknown[] = [];
let fixture: unknown;
let cells = 0;
const mime: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
function replay(tool: string) {
  const handoff = tool !== "browser_act";
  requests = [{ request_ref: "browser-request", category: "command", reason: "Check the page", executable: tool, command_count: 1,
    approval: { action_kind: "other", count: 1, risk: "low", targets: [], examples: [],
      operation: { tool, access: "change", targets: ["example.test"], browser_tab: "remote-tab", allow_conversation: false,
        sign_in_step: "mfa", wait_reason: "secure_field", browser_steps: [{ action: "click", role: "button", name: "Confirm", frame: "main", addons: [] }] } } }];
  const turn = { ...HARNESS_SS03_OBSERVER_VIEW.latest_turn!, id: "browser-turn", state: "waiting_for_form" as const, cancellable: true,
    progress: { safe_progress_rows: [] } };
  const view = { ...HARNESS_SS03_OBSERVER_VIEW, session_id: session, active_turn: turn, latest_turn: turn,
    messages: HARNESS_MESSAGES.filter(message => message.role === "user").slice(0, 1), authority_requests: requests };
  fixture = { messages: view.messages, background: "plain", sessionView: view,
    navigation: { ...HARNESS_NAVIGATION, projects: [], chats: [{
      ...HARNESS_NAVIGATION.chats[0], id: session, title: "Browser task", attention_required: handoff, active_turn_state: handoff ? "waiting_for_form" : "running",
    }] } };
}
async function routePage(page: Page) {
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: readFileSync(join(dist, "index.html"), "utf8")
      .replace("<head>", `<head><script>window.butlerConversationFixture=${JSON.stringify(fixture).replaceAll("<", "\\u003c")}</script>`) });
    const file = join(dist, url.pathname);
    if (url.pathname.startsWith("/assets/") && existsSync(file)) return route.fulfill({ contentType: mime[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
    if (route.request().method() === "POST") {
      commands.push(url.pathname);
      if (url.pathname.startsWith("/authority-requests/")) {
        const decision = url.pathname.endsWith("/allow") ? "allowed" : "denied";
        requests = [];
        return route.fulfill({ json: { ok: true, data: { request_ref: "browser-request", decision, scheduled: true } } });
      }
    }
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: { session_id: session,
      revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-6-luna", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } } } });
    const data = url.pathname === "/authority-requests" ? { requests } : url.pathname === "/session-queue" ? { queued_messages: [] } : {};
    return route.fulfill({ json: { ok: true, data } });
  });
}
async function check(page: Page, tool: string, lang: "ko" | "en", width: number, theme: string) {
  replay(tool);
  const copy = getAppCopy(lang === "ko" ? "ko-KR" : "en-US");
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`${base}?visual=components&theme=${theme}&locale=${lang}`);
  assert.equal(await page.evaluate(() => Boolean((window as Window & { butlerBrowser?: unknown }).butlerBrowser)), false);
  const handoff = tool !== "browser_act";
  const panel = page.locator(`[data-test-class="${handoff ? "composer-browser-handoff" : "composer-authority-decision"}"]`);
  await panel.waitFor({ timeout: 10000 }).catch(async error => { await page.screenshot({ path: join(output!, "fixture-failure.png") }); console.error(errors, await page.locator("body").innerText()); throw error; });
  assert.equal(await page.locator('[data-slot="tab-rail"], [data-test-class="titlebar-browser-toggle"], [data-test-class="browser-entry"]').count(), 0);
  assert.equal(await panel.getByRole("button", { name: copy.interfaceTemplates.approvalRequest.signInHandoff.openTab, exact: true }).count(), 0);
  assert.equal(await panel.locator('[data-slot="composer-decision-media"]').count(), 0, "no still exists: no thumbnail placeholder");
  if (handoff) {
    const where = before ? (lang === "ko" ? "데스크톱 앱에서 마무리해 주세요" : "Finish in the desktop app") : copy.interfaceTemplates.approvalRequest.signInHandoff.onDesktop;
    await panel.getByText(where, { exact: true }).waitFor();
    const toast = page.locator("[data-sonner-toast]");
    await toast.first().waitFor();
    if (!before) assert((await toast.allTextContents()).join(" ").includes(copy.interfaceTemplates.approvalRequest.signInHandoff.onDesktop));
  }
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(output!, `${before ? "before" : "after"}-${tool}-${lang}-${theme}-${width}.png`) });
  const action = handoff ? copy.interfaceTemplates.approvalRequest.signInHandoff.stop : copy.interfaceDetails.allowOnce;
  // Exercise both allow and deny through the actual store/HTTP path.
  if (handoff) await panel.getByRole("button", { name: action, exact: true }).click();
  else await panel.getByRole("button", { name: theme === "light" ? action : copy.interfaceDetails.deny, exact: true }).click();
  await assertCommand(handoff ? "/turns/browser-turn/cancel" : `/authority-requests/browser-request/${theme === "light" ? "allow" : "deny"}`);
  cells++;
}
async function assertCommand(path: string) {
  const deadline = Date.now() + 5000;
  while (!commands.includes(path) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert(commands.includes(path), `real command ${path}`);
  commands.length = 0;
}
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await routePage(page);
  for (const width of [390, 1280]) for (const theme of ["light", "dark"]) for (const lang of ["ko", "en"] as const) {
    for (const tool of ["browser_act", "browser_sign_in_wait", "browser_pay_wait", "browser_wait_for_user"]) await check(page, tool, lang, width, theme);
  }
  assert.deepEqual(errors, [], "no console or renderer errors");
  console.log(JSON.stringify({ cells, consoleErrors: errors.length, modelCalls: 0 }));
} finally { await browser.close(); }
