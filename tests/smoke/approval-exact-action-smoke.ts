// test-category: security
// Pending approvals show complete reviewed inputs on the real conversation surface.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { HARNESS_MESSAGES, HARNESS_MODEL_CATALOG, HARNESS_NAVIGATION, HARNESS_SS03_OBSERVER_VIEW } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";
import { EMPTY_SETTINGS } from "../../packages/butler-app/client/ui/src/app/constants.ts";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const before = Bun.argv.includes("--before");
const output = process.env.BUTLER_APPROVAL_EXACT_SHOTS;
assert(output, "Set BUTLER_APPROVAL_EXACT_SHOTS to a temporary screenshot directory");
mkdirSync(output, { recursive: true });
const dist = resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist");
assert(existsSync(join(dist, "index.html")), "Build the UI first");
const base = "http://approval-exact.localhost/";
const contentTypes: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".html": "text/html", ".wasm": "application/wasm" };
const cases = [
  { tool: "create_automation", kind: "manage_schedule", input: { title: "소식 검토", prompt: "새 항목을 검토하고 보고해 주세요.", schedule_type: "interval", interval_minutes: 60 }, text: "새 항목을 검토하고 보고해 주세요." },
  { tool: "update_explicit_memory", kind: "other", input: { kind: "instruction", text: "새 항목을 검토하기 전에 출처를 확인해 주세요.", duration: "always", source: "연결된 항목" }, text: "새 항목을 검토하기 전에 출처를 확인해 주세요." },
  { tool: "start_topic_conversation", kind: "start_conversation", input: { title: "항목 검토", destination: "chat", follow_up: "항목을 비교하고 결과를 알려 주세요." }, text: "항목을 비교하고 결과를 알려 주세요." },
  { tool: "call_mcp_tool", kind: "use_connector", input: { recipient: "review@example.test", subject: "검토 결과" }, text: "review@example.test" },
];
function sessionView(item: typeof cases[number]): SessionView {
  const approval = { operation: { tool: item.tool, access: "change", targets: [item.tool], allow_conversation: false },
    action_kind: item.kind, targets: [{ kind: "other", path: item.tool }], count: 1, examples: [JSON.stringify(item.input)], risk: "medium",
    ...(item.tool === "create_automation" ? { schedule: { title: "소식 검토", schedule_type: "interval", interval_seconds: 3600, access_mode: "full_access" } } : {}) };
  const turn = { ...HARNESS_SS03_OBSERVER_VIEW.latest_turn!, id: "review-turn", turn_id: "review-turn", state: "waiting_for_form" };
  return { ...structuredClone(HARNESS_SS03_OBSERVER_VIEW), session_id: "butler-client", kind: "chat", relation: undefined,
    status: "active", active_turn: turn, latest_turn: turn, workers: [], steward_children: [],
    messages: [{ ...HARNESS_MESSAGES[0]!, turn_id: "review-turn", text: "연결된 항목을 검토해 주세요." }],
    authority_requests: [{ request_ref: "review-ref", category: "reviewed_effect", reason: "authority.taintReason", executable: item.tool,
      command_count: 1, source_turn_id: "review-turn", source_session_id: "butler/app-butler-client", scope: { title: "확인 필요", description: "이 작업" }, approval }] };
}
let fixture: Record<string, unknown>;
const browser = await launchSmokeBrowser();
const page = await browser.newPage({ reducedMotion: "reduce" });
const errors: string[] = [];
const requests = new Set<string>();
page.on("pageerror", error => errors.push(error.message));
let screenshots = 0;
try {
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    requests.add(url.pathname);
    if (url.pathname === "/") {
      const html = readFileSync(join(dist, "index.html"), "utf8").replace("<head>", `<head><script>window.butlerConversationFixture=${JSON.stringify(fixture).replaceAll("<", "\\u003c")}</script>`);
      return route.fulfill({ contentType: "text/html", body: html });
    }
    const path = normalize(join(dist, decodeURIComponent(url.pathname)));
    if (path.startsWith(dist + sep) && existsSync(path) && statSync(path).isFile()) return route.fulfill({ contentType: contentTypes[extname(path)] ?? "application/octet-stream", body: readFileSync(path) });
    if (url.pathname === "/settings") return route.fulfill({ json: { ok: true, data: { ...EMPTY_SETTINGS, ...(fixture.settings as object) } } });
    if (url.pathname === "/model-catalog") return route.fulfill({ json: { ok: true, data: HARNESS_MODEL_CATALOG } });
    const view = fixture.sessionView as ReturnType<typeof sessionView>;
    if (url.pathname === "/session-view") return route.fulfill({ json: { protocol_version: "butler.app.v1", data: view } });
    if (url.pathname === "/authority-requests") return route.fulfill({ json: { ok: true, data: { requests: view.authority_requests } } });
    if (url.pathname === "/messages") return route.fulfill({ json: { ok: true, data: { messages: view.messages } } });
    if (url.pathname === "/navigation") return route.fulfill({ json: { ok: true, data: HARNESS_NAVIGATION } });
    if (url.pathname === "/projects/butler/canon/sidebar") return route.fulfill({ json: { ok: true, data: { project_id: "butler", groups: [] } } });
    if (url.pathname === "/projects/butler/canon") return route.fulfill({ json: { ok: true, data: { project_id: "butler", plans: [], backlog: [], backlog_revision: 0 } } });
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    const data = /^\/sessions\/[^/]+\/controls$/u.test(url.pathname) ? { session_id: "butler-client", revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-5.6-sol", access_mode: "full_access", reasoning_effort: "none", plan_mode: false } } : {};
    return route.fulfill({ json: { ok: true, data } });
  });
  for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
    for (const background of ["plain", "wallpaper"]) for (const completed of [false, true]) {
      for (const item of cases) {
        const view = sessionView(item);
        fixture = { messages: view.messages, sessionView: view, background,
          settings: { onboarding: { consent_version: 2, accepted_at: "2026-10-01T00:00:00Z", completed_at: completed ? "2026-10-01T00:00:00Z" : null } } };
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${base}?visual=components&theme=${theme}&locale=ko`);
        const panel = page.locator('[data-test-class="composer-authority-decision"]').first();
        await panel.waitFor();
        await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); });
        const more = panel.getByRole("button", { name: /^더\s?보기$/u });
        if (await more.isVisible()) await more.click();
        assert.equal(await page.locator('[data-sonner-toast][data-type="error"]').count(), 0, "fixture requests succeed");
        if (!before) {
          const field = panel.locator("p").filter({ hasText: item.text }).last();
          const fits = () => field.evaluate(node => node.getBoundingClientRect().bottom <= node.parentElement!.getBoundingClientRect().bottom + 1);
          if (!await fits()) { await more.waitFor(); await more.click(); }
          await page.waitForFunction(text => {
            const field = [...document.querySelectorAll('[data-slot="composer-decision-details"] p')].find(node => node.textContent?.includes(text));
            return Boolean(field && field.getBoundingClientRect().bottom <= field.parentElement!.getBoundingClientRect().bottom + 1);
          }, item.text);
        }
        const text = await panel.innerText();
        assert.equal(text.includes(item.text), !before, `${item.tool}: exact input visibility`);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(output, `${before ? "before" : "after"}-${width}-${theme}-${background}-${completed ? "completed" : "pending"}-${item.tool}.png`) });
        screenshots++;
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, before, screenshots, rendererErrors: errors.length }));
} catch (error) {
  await page.screenshot({ path: join(output, `${before ? "before" : "after"}-failure.png`) });
  console.error((await page.locator("body").innerText()).slice(0, 2000));
  console.error([...requests]);
  console.error(await page.evaluate(() => localStorage.getItem("butler.ui-crashes.v1")));
  throw error;
} finally {
  await browser.close();
}
