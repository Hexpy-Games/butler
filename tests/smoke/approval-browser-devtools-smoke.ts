// test-category: security
// The browser DevTools card on the real conversation surface: exact read, site and
// sign-in state; the conversation-wide allow only where it stands, masking said out loud.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { HARNESS_MESSAGES, HARNESS_MODEL_CATALOG, HARNESS_NAVIGATION, HARNESS_SS03_OBSERVER_VIEW } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";
import { EMPTY_SETTINGS } from "../../packages/butler-app/client/ui/src/app/constants.ts";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const output = process.env.BUTLER_APPROVAL_DEVTOOLS_SHOTS;
assert(output, "Set BUTLER_APPROVAL_DEVTOOLS_SHOTS to a temporary screenshot directory");
mkdirSync(output, { recursive: true });
const dist = resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist");
assert(existsSync(join(dist, "index.html")), "Build the UI first");
const base = "http://approval-devtools.localhost/";
const contentTypes: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".html": "text/html", ".wasm": "application/wasm" };

/** The card as the agent sends it (see the `browser_devtools` E2E scenarios). */
const cases = {
  "signed-out": { mode: "signed_out", read: "console", risk: "low", conversation: true },
  "signed-in": { mode: "signed_in", read: "network", risk: "medium", conversation: false },
  "signed-in-dom": { mode: "signed_in", read: "dom", risk: "medium", conversation: false },
  "signed-in-dom-selector": { mode: "signed_in", read: "dom", risk: "medium", conversation: false, selector: "form#login" },
} as const;
type Name = keyof typeof cases;
type Case = { mode: "signed_in" | "signed_out"; read: "console" | "network" | "dom"; risk: "low" | "medium"; conversation: boolean; selector?: string };

function sessionView(name: Name): SessionView {
  const item: Case = cases[name];
  const approval = { action_kind: "web_request", targets: [{ kind: "other", path: "example.com" }], count: 1, examples: [], risk: item.risk,
    operation: { tool: "browser_devtools", access: "read_only", targets: ["example.com", "shop.example.com", ...(item.selector ? [item.selector] : [])], allow_conversation: item.conversation, browser_mode: item.mode, devtools_read: item.read } };
  const turn = { ...HARNESS_SS03_OBSERVER_VIEW.latest_turn!, id: "devtools-turn", turn_id: "devtools-turn", state: "waiting_for_form" };
  return { ...structuredClone(HARNESS_SS03_OBSERVER_VIEW), session_id: "butler-client", kind: "chat", relation: undefined,
    status: "active", active_turn: turn, latest_turn: turn, workers: [], steward_children: [],
    messages: [{ ...HARNESS_MESSAGES[0]!, turn_id: "devtools-turn", text: "결제 페이지가 왜 안 뜨는지 봐 줘." }],
    authority_requests: [{ request_ref: "devtools-ref", category: "reviewed_effect", reason: "browser_devtools", executable: "browser_devtools",
      command_count: 1, source_turn_id: "devtools-turn", source_session_id: "butler/app-butler-client", scope: { title: "browser_devtools", description: "허용한 대상·입력에만 적용" }, approval }] };
}

let fixture: { messages: unknown; sessionView: SessionView; background: string; settings: object };
const browser = await launchSmokeBrowser();
const context = await browser.newContext({ deviceScaleFactor: 2, reducedMotion: "reduce" });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", async route => {
  const url = new URL(route.request().url());
  if (url.pathname === "/") {
    const html = readFileSync(join(dist, "index.html"), "utf8").replace("<head>", `<head><script>window.butlerConversationFixture=${JSON.stringify(fixture).replaceAll("<", "\\u003c")}</script>`);
    return route.fulfill({ contentType: "text/html", body: html });
  }
  const path = normalize(join(dist, decodeURIComponent(url.pathname)));
  if (path.startsWith(dist + sep) && existsSync(path) && statSync(path).isFile()) return route.fulfill({ contentType: contentTypes[extname(path)] ?? "application/octet-stream", body: readFileSync(path) });
  if (url.pathname === "/settings") return route.fulfill({ json: { ok: true, data: { ...EMPTY_SETTINGS, ...fixture.settings } } });
  if (url.pathname === "/model-catalog") return route.fulfill({ json: { ok: true, data: HARNESS_MODEL_CATALOG } });
  const view = fixture.sessionView;
  if (url.pathname === "/session-view") return route.fulfill({ json: { protocol_version: "butler.app.v1", data: view } });
  if (url.pathname === "/authority-requests") return route.fulfill({ json: { ok: true, data: { requests: view.authority_requests } } });
  if (url.pathname === "/messages") return route.fulfill({ json: { ok: true, data: { messages: view.messages } } });
  if (url.pathname === "/navigation") return route.fulfill({ json: { ok: true, data: HARNESS_NAVIGATION } });
  if (url.pathname === "/projects/butler/canon/sidebar") return route.fulfill({ json: { ok: true, data: { project_id: "butler", groups: [] } } });
  if (url.pathname === "/projects/butler/canon") return route.fulfill({ json: { ok: true, data: { project_id: "butler", plans: [], backlog: [], backlog_revision: 0 } } });
  if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
  const data = /^\/sessions\/[^/]+\/controls$/u.test(url.pathname) ? { session_id: "butler-client", revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-5.6-sol", access_mode: "full_access" } } : {};
  return route.fulfill({ json: { ok: true, data } });
});

async function crop(name: string, width: number, region: { x: number; y: number; width: number; height: number }) {
  const padded = { x: Math.max(0, region.x - 12), y: Math.max(0, region.y - 12), width: Math.min(width - Math.max(0, region.x - 12), region.width + 24), height: region.height + 24 };
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Entrance motion settles well within this; the wallpaper's own animation never does.
    await new Promise(resolve => setTimeout(resolve, 400));
    await new Promise(requestAnimationFrame);
  });
  await page.screenshot({ path: join(output!, `${name}.png`), clip: padded });
}

let screenshots = 0;
try {
  for (const locale of ["ko", "en"] as const) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US");
    const request = copy.interfaceTemplates.approvalRequest;
    const details = copy.interfaceDetails;
    for (const name of Object.keys(cases) as Name[]) {
      const item: Case = cases[name];
      fixture = { messages: sessionView(name).messages, sessionView: sessionView(name), background: "wallpaper",
        settings: { onboarding: { consent_version: 2, accepted_at: "2026-10-01T00:00:00Z", completed_at: "2026-10-01T00:00:00Z" } } };
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}?visual=components&theme=${theme}&locale=${locale}`);
      const panel = page.locator('[data-test-class="composer-authority-decision"]').first();
      await panel.waitFor();
      const text = await panel.innerText();
      const mode = request.browserMode[item.mode];
      assert(text.includes(request.devtools.title(request.devtools.read[item.read], "example.com", mode)), `${name} ${locale}: exact read, site and sign-in state\n${text}`);
      assert(text.includes(request.devtools.tab("shop.example.com")), `${name} ${locale}: the tab's host\n${text}`);
      if (item.selector) assert(text.includes(request.devtools.selector(item.selector)), `${name} ${locale}: a labelled selector\n${text}`);
      assert.equal(text.includes(request.devtools.masked[item.read]), item.mode === "signed_in", `${name} ${locale}: masking line\n${text}`);
      assert(text.includes(copy.interfaceTemplates.approvalRequest.risk[item.risk]), `${name} ${locale}: risk\n${text}`);
      assert(!text.includes(request.webRequestDesc), `${name} ${locale}: not a web request sentence\n${text}`);
      const shot = `${name}-${theme}-${width === 1440 ? "desktop" : "phone"}-${locale}`;
      await crop(shot, width, (await panel.boundingBox())!);
      screenshots++;

      const scope = panel.getByRole("button", { name: details.allowScope });
      if (!item.conversation) {
        // No standing grant on a signed-in tab: nothing to choose in the scope menu.
        assert(await scope.isDisabled(), `${name} ${locale}: scope menu off`);
        continue;
      }
      await scope.click();
      const entry = page.getByRole("menuitem", { name: new RegExp(details.allowConversation, "u") });
      await entry.waitFor();
      const menuText = await entry.innerText();
      assert(menuText.includes(request.devtools.covers("example.com")), `${locale}: what the allow covers\n${menuText}`);
      assert.equal(await page.getByRole("menuitem", { name: new RegExp(details.allowSite, "u") }).count(), 0, `${locale}: no always-allow`);
      const a = (await panel.boundingBox())!, b = (await entry.boundingBox())!;
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      await crop(`${name}-menu-${theme}-${width === 1440 ? "desktop" : "phone"}-${locale}`, width,
        { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y });
      screenshots++;
      await page.keyboard.press("Escape");
    }
  }
  for (const locale of ["ko", "en"] as const) for (const theme of ["light", "dark"]) {
    const view = sessionView("signed-out");
    const row = { id: "devtools-row", kind: "used_tool", state: "delivered", safe_label: "browser_devtools", safe_tool_name: "browser_devtools", tool_call_id: "devtools-call", bridge_phase: "btcc_operation", created_at: "2026-10-30T00:00:00.000Z" };
    const turn = { ...view.latest_turn!, state: "running", progress: { ...view.latest_turn!.progress!, safe_progress_rows: [row] } };
    fixture = { messages: view.messages, sessionView: { ...view, active_turn: turn, latest_turn: turn, authority_requests: [] }, background: "plain",
      settings: { onboarding: { consent_version: 2, accepted_at: "2026-10-01T00:00:00Z", completed_at: "2026-10-01T00:00:00Z" } } };
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}?visual=components&theme=${theme}&locale=${locale}`);
    const label = getAppCopy(locale === "ko" ? "ko-KR" : "en-US").guided.tools.browser_devtools!;
    const shown = page.getByText(label).first();
    await shown.waitFor();
    const box = (await shown.boundingBox())!;
    await crop(`tool-row-${theme}-desktop-${locale}`, 1440, { x: box.x - 28, y: box.y - 4, width: 320, height: box.height + 8 });
    screenshots++;
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, screenshots, rendererErrors: errors.length }));
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png") });
  console.error((await page.locator("body").innerText()).slice(0, 2000));
  throw error;
} finally {
  await browser.close();
}
