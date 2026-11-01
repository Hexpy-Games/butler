// test-category: security
// Exact values draw their own characters: on an approval card and in a confirmation dialog's details, `x` between
// digits stays `x` and `->` stays two characters, while the body font keeps its alternates in message prose.
// The body font (Pretendard) draws `2876x6` with the `×` glyph and `a->b` with an arrow unless ligatures are off,
// so each check compares the width the element draws against the same characters drawn one glyph each.
// The real project-hook dialog is checked in app-folder-trust-smoke, which needs the native Agent.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Page } from "playwright";
import { HARNESS_MESSAGES, HARNESS_MODEL_CATALOG, HARNESS_NAVIGATION, HARNESS_SS03_OBSERVER_VIEW } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";
import { EMPTY_SETTINGS } from "../../packages/butler-app/client/ui/src/app/constants.ts";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import type { GrantRecord } from "../../packages/butler-app/client/ui/src/components/settings/grantRows.ts";
import { drawsSubstitutes } from "../support/exact-glyphs.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

/** `--before` asserts the substitution on a build without the change and captures the same crops. */
const before = Bun.argv.includes("--before");
const output = process.env.BUTLER_EXACT_TEXT_SHOTS ?? mkdtempSync(join(tmpdir(), "butler-exact-text-"));
mkdirSync(output, { recursive: true });
const dist = resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist");
assert(existsSync(join(dist, "index.html")), "Build the UI first");
const base = "http://exact-text.localhost/";
const contentTypes: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".html": "text/html", ".wasm": "application/wasm" };
setAppCopyLanguage("ko");
const path = "/Users/someone/shots/2876x6/a->b.png";
// After a Hangul word the digits join the Hangul run and the font sees no digit before `x`; a Latin word keeps them Latin.
const prose = "사진을 size 2876x6 크기로 줄여 a->b 폴더에 넣어 주세요.";
const grant: GrantRecord = { grant_ref: "grant-1", session_id: "butler-client", capability: "edit_file", target: path, cwd: null, scope: "always",
  session_title: null, project_id: null, project_name: null, workspace_path: "/Users/someone", created_at: "2026-10-01T00:00:00Z" };

function sessionView(): SessionView {
  const approval = { operation: { tool: "edit_file", access: "change", targets: [path] }, action_kind: "edit_files",
    targets: [{ kind: "folder", path: "garden" }, { kind: "outside", path }], count: 1, examples: [path], risk: "high" };
  const turn = { ...HARNESS_SS03_OBSERVER_VIEW.latest_turn!, id: "review-turn", turn_id: "review-turn", state: "waiting_for_form" };
  return { ...structuredClone(HARNESS_SS03_OBSERVER_VIEW), session_id: "butler-client", kind: "chat", relation: undefined,
    status: "active", active_turn: turn, latest_turn: turn, workers: [], steward_children: [],
    messages: [{ ...HARNESS_MESSAGES[0]!, turn_id: "review-turn", text: prose }],
    authority_requests: [{ request_ref: "review-ref", category: "reviewed_effect", reason: "Reviewed operation", executable: "edit_file",
      command_count: 1, source_turn_id: "review-turn", source_session_id: "butler/app-butler-client", scope: { title: "확인 필요", description: "이 작업" }, approval }] } as SessionView;
}

async function openRevokeDialog(page: Page) {
  const showSidebar = page.getByRole("button", { name: appCopy.titlebar.showLeftPanel, exact: true });
  const settings = page.getByRole("button", { name: appCopy.sidebar.settings, exact: true });
  await settings.or(showSidebar).first().waitFor();
  if (await showSidebar.isVisible()) await showSidebar.click();
  await settings.click();
  await page.getByRole("button", { name: appCopy.settings.sections.security, exact: true }).click();
  await page.locator('[data-test-class="grant-row"]').getByRole("button", { name: appCopy.settings.grants.revoke, exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  return dialog;
}

let fixture: Record<string, unknown>;
const browser = await launchSmokeBrowser();
const page = await browser.newPage({ reducedMotion: "reduce", deviceScaleFactor: 2 });
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
const measured: Record<string, unknown> = {};
let screenshots = 0;
try {
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") {
      const html = readFileSync(join(dist, "index.html"), "utf8").replace("<head>", `<head><script>window.butlerConversationFixture=${JSON.stringify(fixture).replaceAll("<", "\\u003c")}</script>`);
      return route.fulfill({ contentType: "text/html", body: html });
    }
    const file = normalize(join(dist, decodeURIComponent(url.pathname)));
    if (file.startsWith(dist + sep) && existsSync(file) && statSync(file).isFile()) return route.fulfill({ contentType: contentTypes[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
    if (url.pathname === "/settings") return route.fulfill({ json: { ok: true, data: { ...EMPTY_SETTINGS, ...(fixture.settings as object) } } });
    if (url.pathname === "/model-catalog") return route.fulfill({ json: { ok: true, data: HARNESS_MODEL_CATALOG } });
    const view = fixture.sessionView as SessionView;
    if (url.pathname === "/session-view") return route.fulfill({ json: { protocol_version: "butler.app.v1", data: view } });
    if (url.pathname === "/authority-requests") return route.fulfill({ json: { ok: true, data: { requests: view.authority_requests } } });
    if (url.pathname === "/authority-permissions") return route.fulfill({ json: { ok: true, data: { permissions: [grant] } } });
    // Security settings around the grants list: no remote access view, no saved keys or accounts.
    if (url.pathname === "/security") return route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "stub" } } });
    if (url.pathname === "/credentials" || url.pathname === "/security/oauth") return route.fulfill({ json: { ok: true, data: { credentials: [] } } });
    if (url.pathname === "/messages") return route.fulfill({ json: { ok: true, data: { messages: view.messages } } });
    if (url.pathname === "/navigation") return route.fulfill({ json: { ok: true, data: HARNESS_NAVIGATION } });
    if (url.pathname === "/projects/butler/canon/sidebar") return route.fulfill({ json: { ok: true, data: { project_id: "butler", groups: [] } } });
    if (url.pathname === "/projects/butler/canon") return route.fulfill({ json: { ok: true, data: { project_id: "butler", plans: [], backlog: [], backlog_revision: 0 } } });
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    const data = /^\/sessions\/[^/]+\/controls$/u.test(url.pathname) ? { session_id: "butler-client", revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-5.6-sol", access_mode: "full_access", reasoning_effort: "none", plan_mode: false } } : {};
    return route.fulfill({ json: { ok: true, data } });
  });
  for (const [width, height] of [[1280, 900], [390, 844]] as const) for (const theme of ["light", "dark"]) {
    const key = `${width}-${theme}`;
    const view = sessionView();
    fixture = { messages: view.messages, sessionView: view, background: "plain",
      settings: { onboarding: { consent_version: 2, accepted_at: "2026-10-01T00:00:00Z", completed_at: "2026-10-01T00:00:00Z" } } };
    await page.setViewportSize({ width, height });
    await page.goto(`${base}?visual=components&theme=${theme}&locale=ko`);
    const panel = page.locator('[data-test-class="composer-authority-decision"]').first();
    await panel.waitFor();
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); });
    assert(await page.evaluate(() => document.fonts.check('16px "Pretendard Variable"')), `${key}: the body font is loaded`);
    await page.evaluate(() => document.querySelectorAll("[data-sonner-toast]").forEach(node => node.remove()));

    // Message prose keeps the body font's alternates; this also proves the font in use substitutes at all.
    const message = page.getByText(prose, { exact: true }).first();
    const proseGlyphs = await drawsSubstitutes(message, `${key} prose`);
    assert(proseGlyphs.substituted, `${key}: prose keeps the body font's alternates: ${JSON.stringify(proseGlyphs.width)}`);
    await message.scrollIntoViewIfNeeded();
    await message.screenshot({ path: join(output, `${before ? "before" : "after"}-prose-${key}.png`) }); screenshots++;

    const line = panel.locator('[data-slot="composer-decision-details"] p').filter({ hasText: "2876x6" }).first();
    const card = await drawsSubstitutes(line, `${key} approval detail`);
    assert.equal(card.substituted, before, `${key}: approval detail ${before ? "draws" : "never draws"} substitutes: ${JSON.stringify(card.width)}`);
    if (!before) assert.equal(card.width.ligatures, "none", `${key}: approval detail turns ligatures off`);
    await panel.screenshot({ path: join(output, `${before ? "before" : "after"}-approval-path-${key}.png`) }); screenshots++;

    const dialog = await openRevokeDialog(page);
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); });
    const detail = dialog.getByText(path, { exact: true }).first();
    const confirm = await drawsSubstitutes(detail, `${key} confirmation detail`);
    assert.equal(confirm.substituted, before, `${key}: confirmation detail ${before ? "draws" : "never draws"} substitutes: ${JSON.stringify(confirm.width)}`);
    await dialog.screenshot({ path: join(output, `${before ? "before" : "after"}-confirm-path-${key}.png`) }); screenshots++;
    measured[key] = { prose: proseGlyphs.width, approval: card.width, confirmation: confirm.width };
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, before, screenshots, measured }));
} catch (error) {
  await page.screenshot({ path: join(output, `${before ? "before" : "after"}-failure.png`) });
  console.error(await page.evaluate(() => localStorage.getItem("butler.ui-crashes.v1")));
  throw error;
} finally {
  await browser.close();
}
