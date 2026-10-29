// test-category: security
import { strict as assert } from "node:assert";
import { assertActivityTimes, assertNeutralAgentMark } from "../support/canon-mcp-layout.ts";
import { captureRegion } from "../support/canon-mcp-crops.ts";
import { captureActivitySample } from "../support/canon-mcp-activity-capture.ts";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { assertAssigneeLayout, mcpFocusAudit, runMcpMatrix } from "../support/canon-mcp-matrix.ts";
import type { EpicDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";
const cases = [1440, 390].flatMap(w => ["light", "dark"].flatMap(t => ["plain", "wallpaper"].map(bg => `${w}-${t}-${bg}`)));
if (await runMcpMatrix(cases, "BUTLER_CANON_MCP_INSPECTOR_CASE", import.meta.path)) process.exit(0);
const [widthText, theme, background] = process.env.BUTLER_CANON_MCP_INSPECTOR_CASE!.split("-");
const width = Number(widthText), wallpaper = background === "wallpaper";
const crops = process.env.BUTLER_SMOKE_CROPS === "1";
const before = process.env.BUTLER_SMOKE_BASELINE === "1";
const shots = process.env.BUTLER_SMOKE_SCREENSHOTS ?? "/tmp/canon-mcp-embedded-screenshots";
mkdirSync(shots, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const headers = { "X-Butler-Delegate-Client": "Claude Code", "X-Butler-Delegate-Client-Name": "claude-code" };
try {
  await server.api("/personalization", { method: "PATCH", body: JSON.stringify({ profile: { principal_name: "하늘" } }) });
  const { project } = await server.api<{ project: { id: string } }>("/projects", post({ source: "scratch", display_name: "명세 검토" }));
  const epic = await server.api<EpicDetail>(`/projects/${project.id}/canon/epics`, post({ title: "연결 도구의 검토", assignee: "app-user" }));
  const other = await server.api<EpicDetail>(`/projects/${project.id}/canon/epics`, post({ title: "다른 검토" }));
  const db = new Database(join(server.butlerData,"agent-runtime/btcc.sqlite"));
  db.run("INSERT INTO canon_spec_nodes(node_id,scope_kind,scope_ref,epic_id,concern_id,visibility,lifecycle,source,created_at,updated_at,created_by) VALUES('shared-spec','project',?,?,'공유 명세','canon','draft','local',1,1,'{}')",[project.id,epic.id]); db.close();
  const pending = await fetch(new URL("canon/list",server.url),{ headers: { ...server.authHeaders,...headers } });
  assert.equal(pending.status,403);
  const { grants } = await server.api<{ grants: Array<{ id: string }> }>("/canon/mcp-grants");
  await server.api(`/canon/mcp-grants/${grants[0]!.id}/allow`,post({}));
  await server.api(`/canon/epics/${epic.id}`,{ method: "PATCH",headers,body: JSON.stringify({ expected_revision: epic.revision,status: "in_progress" }) });
  await server.api(`/canon/epics/${epic.id}/comments`,{ ...post({ body: "초안의 연결 흐름을 확인했습니다.\n권한 변경 시 안내도 함께 살펴보겠습니다." }),headers });
  for (let n = 0; n < 105; n++) await server.api(`/canon/epics/${epic.id}/comments`, { ...post({ body: "검토 기준과 예외 상황을 정리했습니다." }), headers });
  await server.api("/canon/specs/shared-spec/proposals",{ ...post({ base_revision: 0,body: "# 검토 기준\n- 연결 권한을 확인합니다.\n- 변경 이력을 남깁니다.\n- 충돌 시 다시 검토합니다.",summary: "검토 기준 보강" }),headers });
  const { session_id } = await server.api<{ session_id: string }>(`/canon/epics/${epic.id}/conversation`,post({}));
  browser = await launchSmokeBrowser();
  {
    await server.api("/settings",{ method: "PATCH",body: JSON.stringify({ language: "ko",appearance_theme: theme,wallpaper: { source: wallpaper ? { kind: "live",module: "butler.silk" } : { kind: "none" },motion: "paused",pauseOnBattery: false } }) });
    const context = await browser.newContext({ viewport: { width,height: 1000 },deviceScaleFactor: 2,reducedMotion: "reduce" });
    try {
      await server.signIn(context);
      const page = await context.newPage();
      const focus = mcpFocusAudit(page);
      await page.addInitScript(id => localStorage.setItem("butler:app-ui-state:v1",JSON.stringify({ schema: "butler.app-ui-state.v1",cached_at: new Date().toISOString(),active_session_id: id,left_open: true,right_open: true })),session_id);
      await page.goto(server.url);
      await page.locator('[data-test-class~="mac-window"]').waitFor();
      const aside = page.getByRole("complementary",{ name: "세션 정보",exact: true });
      if (!await aside.isVisible()) await page.locator('[data-test-class="session-info-toggle"]').click();
      const detail = aside.locator('[data-test-class="canon-epic-detail"]'); await detail.waitFor();
      if (!before) {
        await detail.getByRole("img",{ name: "하늘 · Claude Code 작업 중",exact: true }).first().waitFor();
        await assertNeutralAgentMark(detail);
        await detail.getByText("검토 기준과 예외 상황을 정리했습니다.",{ exact: true }).first().waitFor();
        assert.equal(await detail.locator('[data-test-class="canon-mcp-proposal"]').count(),1);
      }
      if (!before) await assertAssigneeLayout(detail);
      const name = `${before ? "before" : "after"}-${width}-${theme}-${wallpaper ? "wallpaper" : "plain"}`;
      if (crops) {
        const header = [detail.locator(":scope > :nth-child(1)"), detail.locator(":scope > :nth-child(2)")];
        await captureRegion(page, shots, `${before ? "before" : "after"}-conversation-inspector-header-${width}-${theme}-${wallpaper ? "wallpaper" : "plain"}`, header);
      } else await page.screenshot({ path: join(shots,`${name}-header.png`),animations: "disabled" });
      if (!before) { await focus.audit(detail); await detail.locator('[data-test-class="canon-activity"]').scrollIntoViewIfNeeded(); }
      if (!crops) await page.screenshot({ path: join(shots,`${name}-activity.png`),animations: "disabled" });
      if (!before) {
        const activity = detail.locator('[data-test-class="canon-activity"]');
        await activity.getByRole("button", { name: "더 보기", exact: true }).click();
        const older = activity.getByText("검토 기준과 예외 상황을 정리했습니다.", { exact: true }).nth(84);
        await older.waitFor();
        const descriptions = () => activity.locator('[data-slot="activity-feed-title"]').locator("../..").locator(":scope > :last-child").allTextContents();
        const loaded = await descriptions();
        const newest = "명세 초안을 확인했습니다. 기준 2개를 더 추가할게요.";
        await server.api(`/canon/epics/${epic.id}/comments`, { ...post({ body: newest }), headers });
        await activity.getByText(newest, { exact: true }).waitFor();
        await older.waitFor();
        assert.equal(await activity.getByRole("button", { name: "더 보기", exact: true }).count(), 1);
        const refresh = page.waitForResponse(response => response.url().endsWith(`/canon/epics/${epic.id}`) && response.request().method() === "GET");
        await server.api(`/canon/epics/${other.id}/comments`, { ...post({ body: "담당자와 검토 일정을 확인했습니다." }), headers });
        await (await refresh).finished();
        await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        await older.waitFor();
        const current = await server.api<EpicDetail>(`/canon/epics/${epic.id}`);
        assert.equal(current.activity?.[0]?.body, newest);
        assert.deepEqual(await descriptions(), [newest, ...loaded]);
        await activity.getByRole("button", { name: "더 보기", exact: true }).click();
        await activity.getByText("권한 변경 시 안내도 함께 살펴보겠습니다.", { exact: false }).waitFor();
        assert.equal(await activity.getByRole("button", { name: "더 보기", exact: true }).count(), 0);
        await assertActivityTimes(activity);
      }
      if (crops && !before) await captureActivitySample(page, server, epic.id, shots,
        `after-activity-${width}-${theme}-${wallpaper ? "wallpaper" : "plain"}`);
      if (!before) {
        const activity = detail.locator('[data-test-class="canon-activity"]');
        await activity.getByText("예정 → 진행 중", { exact: true }).waitFor();
        assert.doesNotMatch(await activity.innerText(), /in_progress|planned/u);
      }
      focus.finish();
      console.log(JSON.stringify({ result: "PASS",before,width,theme,wallpaper,embedded: true,clipped: 0 }));
    } finally { await context.close(); }
  }
} finally { await browser?.close(); await server.stop(); }
