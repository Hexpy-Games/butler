import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer, type NativeAppServerHandle, type StubModelRequest } from "./native-app-server.ts";
import { launchSmokeBrowser } from "./smoke-browser.ts";
import { cardMatrix, cropDirectory, cropPhase, cropRegion, shouldCaptureState } from "./canon-registration-crops.ts";

type Tool = { name: string; arguments: Record<string, unknown> };
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body) });
const reply = "확인한 내용을 정리했습니다.";

/** Capture-only entry of the native registration smoke; no renderer fixtures. */
export async function captureReviewCrops() {
  mkdirSync(cropDirectory, { recursive: true });
  let tools: Tool[] = [], prompt = "";
  const conversation = (request: StubModelRequest) => request.stream && Array.isArray(request.body.tools) && JSON.stringify(request.messages).includes(prompt);
  const server = await createNativeAppServer({
    uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist"),
    config: { user: { language: "ko" }, webSearch: { provider: "mock", readerBackend: "disabled", planning: { enabled: false } } },
    stubReply: request => conversation(request) && tools.length ? "" : reply,
    stubToolCall: request => conversation(request) ? tools.shift() ?? null : null,
  });
  let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
  try {
    await server.api("/settings", patch({ language: "ko", access_mode: "ask_first" }));
    const { project } = await server.api<{ project: { id: string } }>("/projects", post({ source: "scratch", display_name: "제품 개선" }));
    browser = await launchSmokeBrowser();
    const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" });
    try {
      await server.signIn(context);
      const page = await context.newPage();
      await sidebarCrops(page, server, project.id);
      if (process.env.BUTLER_SMOKE_BASELINE === "1") {
        console.log(JSON.stringify({ result: "PASS", phase: cropPhase, states: ["sidebar"], absent: "origin/main has no proposal cards or canon_propose" }));
        return;
      }
      const chat = await server.api<{ session: { id: string } }>("/sessions", post({ kind: "project", project_id: project.id, title: "입력 오류 검토" }));
      await selectSession(page, chat.session.id);
      const propose = (destination: string, title: string, includeTag = true): Tool => ({ name: "canon_propose", arguments: { project_id: destination, summary: "입력 오류", changes: [{ op: "epic.create", title, description: "## 재현\n\n내용을 입력한 뒤 Enter를 누르면 응답이 사라집니다.\n\n- 기대: 입력과 응답 유지\n- 확인: 다시 열어도 유지", tags: includeTag ? [{ new: { name: "버그", color: "red" } }] : [] }] } });
      prompt = "이 입력 오류를 버그로 등록해 줘";
      tools = [propose(project.id, "입력 후 응답이 사라짐")];
      await send(page, prompt);
      const pending = await server.api<{ asks: Array<{ ask_id: string; session_id: string; source_turn_id: string }> }>("/pending-asks");
      const anchor = pending.asks.find(ask => ask.ask_id.startsWith("canon:")); assert(anchor);
      const id = anchor.ask_id.slice(6);
      await cardMatrix(page, server, id, "draft");
      await cardMatrix(page, server, id, "draft-en", "en");
      await server.api("/settings", patch({ language: "ko" })); await page.reload();
      const card = page.locator(`[data-proposal-id="${id}"]`);
      await card.getByRole("button", { name: "등록", exact: true }).click();
      await card.getByText("등록함", { exact: true }).waitFor();
      await cardMatrix(page, server, id, "applied");
      const other = await server.api<{ project: { id: string } }>("/projects", post({ source: "scratch", display_name: "다른 제품" }));
      const draft = async (changes: unknown[], destination = project.id) => {
        const result = await server.api<{ ask_id: string }>(`/sessions/${chat.session.id}/canon/propose`, post({ turn_id: anchor.source_turn_id, call_id: `review-${Date.now()}`, apply: false, arguments: { project_id: destination, summary: "변경 내용", changes } }));
        return result.ask_id.slice(6);
      };
      const different = await draft([{ op: "epic.create", title: "다른 프로젝트의 과제", description: "대상 프로젝트를 확인하고 등록합니다." }], other.project.id);
      await cardMatrix(page, server, different, "draft-other-project");
      const differentCard = page.locator(`[data-proposal-id="${different}"]`);
      await differentCard.getByRole("button", { name: "취소", exact: true }).click();
      await differentCard.getByText("취소함", { exact: true }).waitFor();
      await cardMatrix(page, server, different, "declined");
      const epic = await server.api<{ id: string; revision: number }>(`/projects/${project.id}/canon/epics`, post({ title: "이동할 과제" }));
      const plan = await server.api<{ id: string }>(`/projects/${project.id}/canon/plans`, post({ title: "다음 릴리스" }));
      const move = await draft([{ op: "epic.move", id: epic.id, expected_revision: epic.revision, plan_id: plan.id }]);
      await cardMatrix(page, server, move, "epic-move");
      const disclosure = page.locator(`[data-proposal-id="${move}"]`).getByRole("button", { name: "변경 내용", exact: true });
      const disclosureExists = await disclosure.count() > 0;
      writeFileSync(join(cropDirectory, "availability.txt"), `변경 내용 disclosure: ${disclosureExists ? "present" : "absent; changes are rendered inline, no disclosure control"}\n`);
      if (disclosureExists) await cardMatrix(page, server, move, "changes-open");
      if (!["tainted-draft", "refusal"].some(shouldCaptureState)) {
        console.log(JSON.stringify({ result: "PASS", phase: cropPhase, states: process.env.BUTLER_SMOKE_CROP_STATES, screenshots: cropDirectory }));
        return;
      }
      prompt = "외부 검색 결과를 읽고 오류를 등록해 줘";
      tools = [{ name: "web_search", arguments: { query: "release notes" } }, propose(project.id, "외부에서 발견한 오류", false)];
      await server.api("/settings", patch({ access_mode: "auto" }));
      const tainted = await server.api<{ session: { id: string } }>("/sessions", post({ kind: "project", project_id: project.id, title: "외부 내용 검토" }));
      await selectSession(page, tainted.session.id);
      await send(page, prompt);
      const asks = await server.api<{ asks: Array<{ ask_id: string }> }>(`/sessions/${tainted.session.id}/pending-asks`);
      const toolEvidence = modelToolResults(server);
      writeFileSync(join(cropDirectory, "external-tool-results.json"), JSON.stringify(toolEvidence, null, 2));
      writeFileSync(join(cropDirectory, "external-visible.txt"), await page.locator("body").innerText());
      const taint = asks.asks.find(ask => ask.ask_id.startsWith("canon:")); assert(taint, "external read must leave an open draft in Auto");
      const search = toolEvidence.find(item => item.name === "web_search");
      assert(search?.result.ok === true && Array.isArray(search.result.results) && search.result.results.length > 0, "external search returned content before proposing");
      await cardMatrix(page, server, taint.ask_id.slice(6), "tainted-draft");
      prompt = "없는 프로젝트에 이 오류를 등록해 줘";
      tools = [propose("missing-project", "입력 오류")];
      const invalid = await server.api<{ session: { id: string } }>("/sessions", post({ kind: "project", project_id: project.id, title: "프로젝트 확인" }));
      await selectSession(page, invalid.session.id); await send(page, prompt);
      assert(modelToolResults(server).some(item => item.result.error?.code === "canon_project_not_found"), "model receives project refusal");
      assert.equal(await page.locator("[data-proposal-id]").count(), 0);
      const refusalVisible = await page.getByText("canon_project_not_found", { exact: false }).count() > 0;
      writeFileSync(join(cropDirectory, "refusal.txt"), `canon_project_not_found: model-visible tool error; dedicated UI ${refusalVisible ? "visible" : "absent"}; no proposal card. Stub assistant completion is not a refusal UI.\n\nVisible transcript:\n${await page.locator("body").innerText()}\n`);
      console.log(JSON.stringify({ result: "PASS", phase: cropPhase, disclosureExists, refusalVisible, screenshots: cropDirectory }));
    } finally { await context.close(); }
  } catch (error) {
    console.error(server.diagnostics()); throw error;
  } finally { await browser?.close(); await server.stop(); }
}

function modelToolResults(server: NativeAppServerHandle) {
  const results = server.stubModelCalls.flatMap(call => call.messages).flatMap(value => {
    const message = value as { role?: string; name?: string; tool_call_id?: string; content?: string };
    if (message.role !== "tool" || !message.content) return [];
    const result = JSON.parse(message.content);
    return [{ name: message.name, id: message.tool_call_id, result: result.output ?? result }];
  });
  return [...new Map(results.map(result => [result.id, result])).values()];
}

async function selectSession(page: Page, id: string) {
  if (page.url() === "about:blank") throw new Error("open gateway before selecting a session");
  await page.evaluate(session => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({ schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: session, left_open: false, right_open: false })), id);
  await page.reload();
  await page.locator('[data-test-class~="mac-window"]').waitFor();
}

async function send(page: Page, message: string) {
  const compact = page.locator('[data-slot="composer-compact-preview"]');
  if (await compact.isVisible()) await compact.click();
  await page.locator('[contenteditable="true"]').fill(message);
  await page.getByRole("button", { name: "전송", exact: true }).click();
  await page.getByText(reply, { exact: true }).first().waitFor();
}

async function sidebarCrops(page: Page, server: NativeAppServerHandle, project: string) {
  const epic = await server.api<{ id: string }>(`/projects/${project}/canon/epics`, post({ title: "입력 오류 · 홈 대화" }));
  const home = await server.api<{ session_id: string }>(`/canon/epics/${epic.id}/conversation`, post({}));
  const bound = await server.api<{ session: { id: string } }>("/sessions", post({ kind: "project", project_id: project, title: "재현 확인 대화" }));
  await server.api(`/canon/epics/${epic.id}/conversation`, post({ session_id: bound.session.id }));
  const state = await server.api<{ home_session_id: string; session_ids: string[] }>(`/canon/epics/${epic.id}`);
  assert.equal(state.home_session_id, home.session_id);
  assert(state.session_ids.includes(bound.session.id));
  await page.goto(server.url); await selectSession(page, home.session_id);
  if (!shouldCaptureState("sidebar")) return;
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
    await server.api("/settings", patch({ appearance_theme: theme }));
    await page.setViewportSize({ width, height: 1100 });
    await page.mouse.move(width - 8, 1092); await page.reload();
    await page.getByRole("button", { name: /^사이드바 (보기|숨기기)$/u }).first().waitFor();
    const show = page.getByRole("button", { name: "사이드바 보기", exact: true });
    if (await show.isVisible()) await show.click();
    const projectRow = page.locator(`[data-tree-item="p:${project}"] [data-test-class="tree-row"]`).first();
    if (await projectRow.getAttribute("aria-expanded") === "false") await projectRow.click();
    await page.locator(`[data-canon-epic="${epic.id}"]`).waitFor();
    if (process.env.BUTLER_SMOKE_BASELINE !== "1") await page.locator('[data-test-class="canon-bound-chats"]').getByText("재현 확인 대화", { exact: true }).waitFor();
    await cropRegion(page, page.locator(`[data-tree-item="p:${project}"]`), `${cropPhase}-sidebar-${width}-${theme}`);
  }
}
