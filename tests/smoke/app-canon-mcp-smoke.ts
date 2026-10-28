// test-category: security
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { onboardingCompletedPatch } from "../../packages/butler-app/client/ui/src/app/onboarding.ts";
import type { SettingsView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { Database } from "bun:sqlite";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";
import { auditCanonCardFocus } from "../support/canon-registration-cards.ts";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import type { CanonGrant } from "../../packages/butler-app/client/ui/src/app/canonTrust.ts";
import type { EpicDetail, PlanDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";
const cases = [1440, 390].flatMap(w => ["light", "dark"].flatMap(t => ["plain", "wallpaper"].flatMap(s => ["pending", "completed"].map(o => `${w}-${t}-${s}-${o}`))));
if (await runSmokeCases(cases, "BUTLER_CANON_MCP_CASE", import.meta.path, { isolate: true })) process.exit(0);
const [widthText, theme, surface, onboarding] = process.env.BUTLER_CANON_MCP_CASE!.split("-");
const before = process.env.BUTLER_SMOKE_BASELINE === "1";
const shots = process.env.BUTLER_SMOKE_SCREENSHOTS ?? "/tmp/canon-mcp-screenshots";
mkdirSync(shots, { recursive: true });
const c = getAppCopy("ko-KR");
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist"), onboardingComplete: onboarding === "completed", config: { user: { language: "ko" } } });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const headers = { "X-Butler-Delegate-Client": "Claude Code", "X-Butler-Delegate-Client-Name": "claude-code" };
const delegated = <T>(path: string, init: RequestInit = {}) => server.api<T>(path, { ...init, headers });
const grants = () => server.api<{ grants: CanonGrant[] }>("/canon/mcp-grants");
try {
  if (onboarding === "pending") {
    // Enter the workspace while leaving first-chat personalization pending.
    const settings = await server.api<SettingsView>("/settings");
    const now = new Date().toISOString();
    await server.api("/settings", { method: "PATCH", body: JSON.stringify(onboardingCompletedPatch(settings.onboarding, now, now)) });
  }
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme, wallpaper: { source: surface === "wallpaper" ? { kind: "live", module: "butler.silk" } : { kind: "none" }, motion: "paused", pauseOnBattery: false } }) });
  await server.api("/personalization", { method: "PATCH", body: JSON.stringify({ profile: { principal_name: "연우" } }) });
  const { project } = await server.api<{ project: { id: string } }>("/projects", post({ source: "scratch", display_name: "캐논 보드" }));
  const plan = await server.api<PlanDetail>(`/projects/${project.id}/canon/plans`, post({ title: "도구 연결" }));
  const epic = await server.api<EpicDetail>(`/projects/${project.id}/canon/epics`, post({ title: "명세 검토", plan_id: plan.id, assignee: "app-user" }));
  const db = new Database(join(server.butlerData, "agent-runtime/btcc.sqlite"));
  db.run("INSERT INTO canon_spec_nodes(node_id,scope_kind,scope_ref,epic_id,concern_id,visibility,lifecycle,source,created_at,updated_at,created_by) VALUES('shared-spec','project',?,?,'공유 명세','canon','draft','local',1,1,'{}')", [project.id, epic.id]);
  db.close();
  browser = await launchSmokeBrowser();
  const context = await browser.newContext({ viewport: { width: Number(widthText), height: 1000 }, reducedMotion: "reduce" });
  let failedPage: import("playwright").Page | undefined;
  try {
    await server.signIn(context);
    const page = await context.newPage();
    failedPage = page;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({ schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), left_open: true, right_open: false })));
    await page.goto(server.url);
    await page.locator('[data-test-class~="mac-window"]').waitFor();
    const capture = async (name: string) => {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(shots, `${before ? "before" : "after"}-${process.env.BUTLER_CANON_MCP_CASE}-${name}.png`), animations: "disabled" });
    };
    const openSettings = async () => {
      await page.locator('[data-test-class~="mac-window"]').waitFor();
      await page.waitForFunction(() => document.documentElement.lang.startsWith("ko"));
      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByRole("dialog", { name: c.commandPalette.label });
      await palette.getByRole("combobox").fill(c.settings.sections.mcp);
      await palette.getByRole("option").filter({ has: page.getByText(c.settings.sections.mcp, { exact: true }) }).first().click();
      await page.locator('[data-settings-section-id="mcp-servers"]').waitFor();
    };
    await openSettings();
    const connected = page.locator('[data-settings-section-id="canon-connected-tools"]');
    if (!before) await connected.getByText(c.canon.mcp.noTools, { exact: true }).waitFor();
    await capture("settings-empty");
    // Exercise a live trust event after the app's initial pending read completed.
    const pendingRead = await fetch(new URL("canon/list", server.url), { headers: { ...server.authHeaders, ...headers } });
    assert.equal(pendingRead.status, 403);
    const grant = (await grants()).grants[0]!; assert(grant);
    const dialog = page.getByRole("dialog", { name: "Claude Code에 캐논 권한을 줄까요?", exact: true });
    if (!before) {
      await dialog.waitFor();
      await dialog.getByText("연우", { exact: true }).waitFor();
      for (const label of Object.values(c.canon.mcp.capabilities)) await dialog.getByText(label, { exact: true }).waitFor();
      await auditCanonCardFocus(page, dialog);
    }
    await capture("trust");
    // A reload also recovers pending grants without another request event.
    await page.reload();
    if (!before) { await dialog.waitFor(); await dialog.getByRole("button", { name: "허용", exact: true }).click(); await dialog.waitFor({ state: "hidden" }); }
    else await server.api(`/canon/mcp-grants/${grant.id}/allow`, post({}));
    await delegated(`/canon/epics/${epic.id}`, { method: "PATCH", body: JSON.stringify({ expected_revision: epic.revision, status: "in_progress" }) });
    for (let n = 0; n < 52; n++) await delegated(`/canon/epics/${epic.id}/comments`, post({ body: n === 51 ? "검토했습니다\n전체 내용" : `의견 ${n}` }));
    const propose = (body: string, summary: string, base_revision = 0) => delegated(`/canon/specs/shared-spec/proposals`, post({ base_revision, body, summary }));
    await propose("# 변경된 명세", "검토할 변경");
    await propose("# 다른 변경", "거절할 변경");
    await propose("# 늦은 변경", "충돌할 변경");
    await page.goto(server.url);
    await page.locator('[data-test-class~="mac-window"]').waitFor();
    await page.waitForFunction(() => document.documentElement.lang.startsWith("ko"));
    const sidebar = page.getByRole("button", { name: "사이드바 보기", exact: true });
    if (await sidebar.isVisible()) await sidebar.click();
    await page.getByRole("button", { name: "캐논 보드 프로젝트 대시보드", exact: true }).click();
    await page.getByRole("tab", { name: "보드", exact: true }).click();
    const card = page.locator(`[data-kanban-item="${epic.id}"]`);
    await card.waitFor();
    if (!before) {
      await card.getByRole("img", { name: "연우 · Claude Code 작업 중", exact: true }).waitFor();
      await card.locator('[data-slot="avatar-badge"] [data-name="claude"]').waitFor();
    }
    await capture("board-sidebar");
    const planGroup = page.locator(`[data-canon-group="${plan.id}"] [data-test-class="canon-sidebar-group"]`);
    const showSidebar = page.getByRole("button", { name: "사이드바 보기", exact: true });
    if (await showSidebar.isVisible()) await showSidebar.click();
    await planGroup.click({ button: "right" });
    await page.getByRole("menuitem", { name: "계획 개요", exact: true }).click();
    const overview = page.locator('[data-test-class="canon-plan-overview"]');
    await overview.waitFor();
    if (!before) await overview.getByRole("img", { name: "연우 · Claude Code 작업 중", exact: true }).waitFor();
    await capture("plan-overview");
    if (await showSidebar.isVisible()) await showSidebar.click();
    await page.getByRole("button", { name: "캐논 보드 프로젝트 대시보드", exact: true }).click();
    await page.getByRole("tab", { name: "보드", exact: true }).click();
    await card.getByRole("button").first().click();
    const detail = page.locator('[data-test-class="canon-epic-detail"]');
    await detail.waitFor();
    await capture("inspector-header");
    if (!before) {
      await detail.getByText("전체 내용", { exact: false }).waitFor();
      await detail.getByRole("button", { name: "더 보기", exact: true }).click();
      await detail.getByText("의견 0", { exact: true }).waitFor();
      const proposals = detail.locator('[data-test-class="canon-mcp-proposal"]');
      assert.equal(await proposals.count(), 3);
      await auditCanonCardFocus(page, proposals.first());
      await capture("inspector-proposals");
      await proposals.filter({ hasText: "거절할 변경" }).getByRole("button", { name: "거절", exact: true }).click();
      await proposals.filter({ hasText: "거절할 변경" }).waitFor({ state: "hidden" });
      await proposals.filter({ hasText: "검토할 변경" }).getByRole("button", { name: "반영", exact: true }).click();
      await proposals.filter({ hasText: "검토할 변경" }).waitFor({ state: "hidden" });
      await proposals.filter({ hasText: "충돌할 변경" }).getByRole("button", { name: "반영", exact: true }).click();
      await page.getByText("다른 사람이 먼저 고쳤습니다", { exact: true }).waitFor();
      await proposals.waitFor({ state: "hidden" });
      assert.equal((await delegated<{ body: string }>("/canon/specs/shared-spec")).body, "# 변경된 명세");
      // Canon events refresh activity and agent state while the inspector stays mounted.
      const current = await server.api<EpicDetail>(`/canon/epics/${epic.id}`);
      await server.api(`/canon/epics/${epic.id}`, { method: "PATCH", body: JSON.stringify({ expected_revision: current.revision, status: "in_review" }) });
      await page.waitForFunction(() => !document.querySelector('[data-test-class="canon-epic-detail"] [aria-label="연우 · Claude Code 작업 중"]'));
    } else await capture("inspector-proposals");
    await page.goto(server.url);
    await openSettings();
    if (!before) {
      await connected.getByText("Claude Code", { exact: true }).waitFor();
      await connected.getByText("허용됨", { exact: true }).waitFor();
      await auditCanonCardFocus(page, connected);
    }
    await capture("settings-allowed");
    if (!before) { await connected.getByRole("button", { name: "권한 해제", exact: true }).click(); await connected.getByText(c.canon.mcp.noTools, { exact: true }).waitFor(); }
    else await server.api(`/canon/mcp-grants/${grant.id}/revoke`, post({}));
    const again = await fetch(new URL("canon/list", server.url), { headers: { ...server.authHeaders, ...headers } });
    assert.equal(again.status,403);
    if (!before) { await dialog.waitFor(); await dialog.getByRole("button", { name: "거절", exact: true }).click(); await dialog.waitFor({ state: "hidden" }); }
    else await server.api(`/canon/mcp-grants/${grant.id}/deny`,post({}));
    if (!before) { await connected.getByText("거절됨", { exact: true }).waitFor(); await auditCanonCardFocus(page, connected); }
    await capture("settings-denied");
    if (!before) { await connected.getByRole("button", { name: "지우기", exact: true }).click(); await connected.getByText(c.canon.mcp.noTools, { exact: true }).waitFor(); }
    assert.equal(errors.length,0,errors.join("\n"));
    console.log(JSON.stringify({ result: "PASS", cell: process.env.BUTLER_CANON_MCP_CASE, before, trustEvent: !before, startupPending: !before, allow: !before, activityPaging: !before, proposalApplyDeny: !before, agent: !before, revokeDelete: !before, clipped: 0 }));
  } catch (error) {
    await failedPage?.screenshot({ path: join(shots, `failure-${process.env.BUTLER_CANON_MCP_CASE}.png`) });
    throw error;
  } finally { await context.close(); }
} finally { await browser?.close(); await server.stop(); }
