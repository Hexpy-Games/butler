// test-category: security
import { strict as assert } from "node:assert";
import { captureRegion } from "../support/canon-mcp-crops.ts";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { onboardingCompletedPatch } from "../../packages/butler-app/client/ui/src/app/onboarding.ts";
import type { SettingsView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { Database } from "bun:sqlite";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { assertAssigneeLayout, mcpFocusAudit, runMcpMatrix } from "../support/canon-mcp-matrix.ts";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import type { CanonGrant } from "../../packages/butler-app/client/ui/src/app/canonTrust.ts";
import type { EpicDetail, PlanDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";
const cases = [1440, 390].flatMap(w => ["light", "dark"].flatMap(t => ["plain", "wallpaper"].flatMap(s => (process.env.BUTLER_SMOKE_CROPS === "1" ? ["completed"] : ["pending", "completed"]).map(o => `${w}-${t}-${s}-${o}`))));
if (await runMcpMatrix(cases, "BUTLER_CANON_MCP_CASE", import.meta.path)) process.exit(0);
const [widthText, theme, surface, onboarding] = process.env.BUTLER_CANON_MCP_CASE!.split("-");
const crops = process.env.BUTLER_SMOKE_CROPS === "1";
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
  const context = await browser.newContext({ viewport: { width: Number(widthText), height: 1000 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  let failedPage: import("playwright").Page | undefined;
  try {
    await server.signIn(context);
    const page = await context.newPage();
    failedPage = page;
    const focus = mcpFocusAudit(page);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({ schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), left_open: true, right_open: false })));
    await page.goto(server.url);
    await page.locator('[data-test-class~="mac-window"]').waitFor();
    const capture = async (name: string, regions?: import("playwright").Locator[], options = {}) => {
      if (crops) {
        if (!regions) return;
        await captureRegion(page, shots, `${before ? "before" : "after"}-${name}-${widthText}-${theme}-${surface}`, regions, options);
      } else {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(shots, `${before ? "before" : "after"}-${process.env.BUTLER_CANON_MCP_CASE}-${name}.png`), animations: "disabled" });
      }
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
    await capture("settings-empty", [before ? page.locator('[data-settings-section-id="mcp-servers"]') : connected]);
    // Exercise a live trust event after the app's initial pending read completed.
    const pendingRead = await fetch(new URL("canon/list", server.url), { headers: { ...server.authHeaders, ...headers } });
    assert.equal(pendingRead.status, 403);
    const grant = (await grants()).grants[0]!; assert(grant);
    const dialog = page.getByRole("dialog", { name: "Claude Code에 캐논 권한을 줄까요?", exact: true });
    if (!before) {
      await dialog.waitFor();
      await dialog.getByText("연우", { exact: true }).waitFor();
      for (const label of Object.values(c.canon.mcp.capabilities)) await dialog.getByText(label, { exact: true }).waitFor();
      await focus.audit(dialog);
    }
    if (!before) {
      await capture("trust", [dialog]);
      await page.keyboard.press("Tab");
      await dialog.getByRole("button", { name: "허용", exact: true }).focus();
      await capture("trust-focus", [dialog], { focus: true });
    }
    // A reload also recovers pending grants without another request event.
    await page.reload();
    if (!before) { await dialog.waitFor(); await dialog.getByRole("button", { name: "허용", exact: true }).click(); await dialog.waitFor({ state: "hidden" }); }
    else await server.api(`/canon/mcp-grants/${grant.id}/allow`, post({}));
    await delegated(`/canon/epics/${epic.id}`, { method: "PATCH", body: JSON.stringify({ expected_revision: epic.revision, status: "in_progress" }) });
    for (let n = 0; n < 52; n++) await delegated(`/canon/epics/${epic.id}/comments`, post({ body: n === 51 ? "명세 초안을 확인했습니다. 기준 2개를 더 추가할게요." : "연결 권한과 검토 기준을 확인했습니다." }));
    const propose = (body: string, summary: string, base_revision = 0) => delegated(`/canon/specs/shared-spec/proposals`, post({ base_revision, body, summary }));
    await propose("# 검토 기준\n- 연결 권한을 확인합니다.\n- 변경 이력을 남깁니다.\n- 충돌 시 다시 검토합니다.", "검토 기준 보강");
    await propose("# 검토 절차\n- 담당자를 확인합니다.\n- 검토 의견을 기록합니다.", "담당자 확인 절차");
    await propose("# 검토 기준\n- 연결 권한을 확인합니다.\n- 완료 기준을 확인합니다.", "완료 기준 추가");
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
    const hideSidebar = page.getByRole("button", { name: c.titlebar.hideLeftPanel, exact: true });
    if (crops && Number(widthText) < 600 && await hideSidebar.isVisible()) await hideSidebar.click();
    if (!before) await focus.audit(card);
    await capture("board-card", [card]);
    if (crops && Number(widthText) < 600 && await sidebar.isVisible()) await sidebar.click();
    if (!before) await focus.audit(page.locator(`[data-canon-epic="${epic.id}"]`));
    await capture("sidebar-row", [page.locator(`[data-canon-epic="${epic.id}"]`)]);
    const planGroup = page.locator(`[data-canon-group="${plan.id}"] [data-test-class="canon-sidebar-group"]`);
    const showSidebar = page.getByRole("button", { name: "사이드바 보기", exact: true });
    if (await showSidebar.isVisible()) await showSidebar.click();
    await planGroup.click({ button: "right" });
    await page.getByRole("menuitem", { name: "계획 개요", exact: true }).click();
    const overview = page.locator('[data-test-class="canon-plan-overview"]');
    await overview.waitFor();
    if (!before) await overview.getByRole("img", { name: "연우 · Claude Code 작업 중", exact: true }).waitFor();
    await page.getByRole("menuitem", { name: "계획 개요", exact: true }).waitFor({ state: "detached" });
    if (!before) await focus.audit(overview);
    await capture("plan-overview", [overview.locator('[data-test-class="canon-plan-epics"]')]);
    if (await showSidebar.isVisible()) await showSidebar.click();
    await page.getByRole("button", { name: "캐논 보드 프로젝트 대시보드", exact: true }).click();
    await page.getByRole("tab", { name: "보드", exact: true }).click();
    await card.getByRole("button").first().click();
    const detail = page.locator('[data-test-class="canon-epic-detail"]');
    await detail.waitFor();
    const headerRegions = [detail.locator(":scope > :nth-child(1)"), detail.locator(":scope > :nth-child(2)")];
    if (!before) { await assertAssigneeLayout(detail); await focus.audit(detail); }
    await capture("inspector-header", headerRegions);
    if (!before) {
      await detail.getByText("명세 초안을 확인했습니다. 기준 2개를 더 추가할게요.", { exact: true }).waitFor();
      await detail.getByRole("button", { name: "더 보기", exact: true }).click();
      await detail.getByText("과제를 만들었습니다", { exact: true }).waitFor();
      const proposals = detail.locator('[data-test-class="canon-mcp-proposal"]');
      assert.equal(await proposals.count(), 3);
      await focus.audit(proposals.first());
      await proposals.first().scrollIntoViewIfNeeded();
      await capture("proposal", [proposals.first()]);
      await proposals.filter({ hasText: "담당자 확인 절차" }).getByRole("button", { name: "거절", exact: true }).click();
      await proposals.filter({ hasText: "담당자 확인 절차" }).waitFor({ state: "hidden" });
      await proposals.filter({ hasText: "검토 기준 보강" }).getByRole("button", { name: "반영", exact: true }).click();
      await proposals.filter({ hasText: "검토 기준 보강" }).waitFor({ state: "hidden" });
      const releaseRefresh = Promise.withResolvers<void>();
      const refreshPath = `**/canon/epics/${epic.id}`;
      if (crops) await page.route(refreshPath, async route => {
        if (route.request().method() === "GET") await releaseRefresh.promise;
        await route.continue();
      });
      try {
        const stale = proposals.filter({ hasText: "완료 기준 추가" });
        await stale.getByRole("button", { name: "반영", exact: true }).click();
        const conflict = page.locator('[data-sonner-toast]').filter({ hasText: "다른 사람이 먼저 고쳤습니다" });
        await conflict.waitFor();
        await capture("proposal-conflict", [stale, conflict], { toast: true });
      } finally { releaseRefresh.resolve(); }
      await proposals.waitFor({ state: "hidden" });
      if (crops) await page.unroute(refreshPath);
      assert.equal((await delegated<{ body: string }>("/canon/specs/shared-spec")).body, "# 검토 기준\n- 연결 권한을 확인합니다.\n- 변경 이력을 남깁니다.\n- 충돌 시 다시 검토합니다.");
      // Canon events refresh activity and agent state while the inspector stays mounted.
      const current = await server.api<EpicDetail>(`/canon/epics/${epic.id}`);
      await server.api(`/canon/epics/${epic.id}`, { method: "PATCH", body: JSON.stringify({ expected_revision: current.revision, status: "in_review" }) });
      await page.waitForFunction(() => !document.querySelector('[data-test-class="canon-epic-detail"] [aria-label="연우 · Claude Code 작업 중"]'));
      await headerRegions[0]!.scrollIntoViewIfNeeded();
      await capture("inspector-cleared", headerRegions);
    }
    await page.goto(server.url);
    await openSettings();
    if (!before) {
      await connected.getByText("Claude Code", { exact: true }).waitFor();
      await connected.getByText("허용됨", { exact: true }).waitFor();
      await focus.audit(connected);
    }
    if (!before) await capture("settings-allowed", [connected]);
    if (!before) {
      await connected.getByRole("button", { name: "권한 해제", exact: true }).click();
      await connected.getByText(c.canon.mcp.noTools, { exact: true }).waitFor();
      await capture("settings-revoked", [connected, page.locator('[data-sonner-toast]').filter({ hasText: c.canon.mcp.revoked })], { toast: true });
    }
    else await server.api(`/canon/mcp-grants/${grant.id}/revoke`, post({}));
    const again = await fetch(new URL("canon/list", server.url), { headers: { ...server.authHeaders, ...headers } });
    assert.equal(again.status,403);
    if (!before) { await dialog.waitFor(); await dialog.getByRole("button", { name: "거절", exact: true }).click(); await dialog.waitFor({ state: "hidden" }); }
    else await server.api(`/canon/mcp-grants/${grant.id}/deny`,post({}));
    if (!before) { await connected.getByText("거절됨", { exact: true }).waitFor(); await focus.audit(connected); }
    if (!before) await capture("settings-denied", [connected]);
    if (!before) { await connected.getByRole("button", { name: "지우기", exact: true }).click(); await connected.getByText(c.canon.mcp.noTools, { exact: true }).waitFor(); }
    if (!before) {
      const en = getAppCopy("en-US");
      await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en" }) });
      await page.reload();
      await page.waitForFunction(() => document.documentElement.lang.startsWith("en"));
      const request = await fetch(new URL("canon/list", server.url), { headers: { ...server.authHeaders, ...headers } });
      assert.equal(request.status, 403);
      const englishDialog = page.getByRole("dialog", { name: en.canon.mcp.trustTitle("Claude Code"), exact: true });
      await englishDialog.waitFor();
      await focus.audit(englishDialog);
      await capture("trust-en", [englishDialog]);
      await englishDialog.getByRole("button", { name: en.canon.mcp.allow, exact: true }).click();
      await englishDialog.waitFor({ state: "detached" });
      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByRole("dialog", { name: en.commandPalette.label });
      await palette.getByRole("combobox").fill(en.settings.sections.mcp);
      await palette.getByRole("option").filter({ has: page.getByText(en.settings.sections.mcp, { exact: true }) }).first().click();
      await connected.getByText(en.canon.mcp.states.allowed, { exact: true }).waitFor();
      await focus.audit(connected);
      await capture("settings-allowed-en", [connected]);
    }
    focus.finish();
    assert.equal(errors.length,0,errors.join("\n"));
    console.log(JSON.stringify({ result: "PASS", cell: process.env.BUTLER_CANON_MCP_CASE, before, trustEvent: !before, startupPending: !before, allow: !before, activityPaging: !before, proposalApplyDeny: !before, agent: !before, revokeDelete: !before, clipped: 0 }));
  } catch (error) {
    await failedPage?.screenshot({ path: join(shots, `failure-${process.env.BUTLER_CANON_MCP_CASE}.png`) });
    throw error;
  } finally { await context.close(); }
} finally { await browser?.close(); await server.stop(); }
