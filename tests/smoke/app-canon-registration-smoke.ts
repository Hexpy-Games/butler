import { captureDestinationVariants } from "../support/canon-registration-destinations.ts";
// test-category: race
import { auditCanonCardFocus, captureRegistrationVariants } from "../support/canon-registration-cards.ts";
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import type { CanonProposal } from "../../packages/butler-app/client/shared/canon-proposal-contracts.ts";
import { captureReviewCrops } from "../support/canon-registration-review.ts";

if (process.env.BUTLER_SMOKE_REVIEW_CROPS === "1") {
  await captureReviewCrops();
  process.exit(0);
}

const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const shots = process.env.BUTLER_SMOKE_SCREENSHOTS ?? "/tmp/canon-registration-screenshots";
mkdirSync(shots, { recursive: true });
let calls = 0;
let projectId = "";
const message = "이 입력 오류를 버그로 등록해 줘";
const conversation = (request: import("../support/native-app-server.ts").StubModelRequest) => request.stream && Array.isArray(request.body.tools) && JSON.stringify(request.messages).includes(message);
const server = await createNativeAppServer({
  uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist"),
  config: { user: { language: "ko" } },
  stubReply: request => conversation(request) && calls === 0 ? "" : "입력 오류 과제 초안을 준비했습니다.",
  stubToolCall: request => conversation(request) && calls++ === 0 ? { name: "canon_propose", arguments: {
    project_id: projectId, summary: "입력 오류", changes: [{ op: "epic.create", title: "입력 후 응답이 사라짐", description: "## 재현\n\n내용을 입력한 뒤 Enter를 누르면 응답이 사라집니다.\n\n- 기대: 입력과 응답 유지\n- 확인: 다시 열어도 유지", tags: [{ new: { name: "버그", color: "red" } }] }],
  } } : null,
});
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "ask_first", language: "ko" }) });
  const p = await server.api<{ project: { id: string } }>("/projects", { method: "POST", body: JSON.stringify({ source: "scratch", display_name: "제품 개선" }) });
  projectId = p.project.id;
  browser = await launchSmokeBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" });
  try {
    await server.signIn(context);
    const page = await context.newPage();
    await page.goto(server.url);
    await page.locator('[data-slot="composer-compact-preview"]').click();
    await page.locator('[contenteditable="true"]').fill(message);
    await page.getByRole("button", { name: "전송", exact: true }).click();
    await page.getByText("입력 오류 과제 초안을 준비했습니다.", { exact: true }).first().waitFor();
    const card = page.locator('[data-test-class="canon-proposal-card"]');
    if (!baseline) {
      await card.waitFor();
      assert.equal(await card.getByRole("combobox", { name: "프로젝트" }).inputValue(), projectId);
      await card.getByRole("combobox", { name: "프로젝트" }).selectOption("@new");
      const add = card.getByRole("button", { name: "등록", exact: true });
      assert(await add.isDisabled());
      await add.hover();
      await page.getByRole("tooltip", { name: "이름을 입력하세요", exact: true }).waitFor();
      await add.focus(); await page.keyboard.press("Enter");
      assert.equal(await card.getAttribute("data-state"), "open");
      await card.getByRole("textbox", { name: "새 프로젝트" }).fill("신규 제품");
      assert(await add.isEnabled());
      await auditCanonCardFocus(page, card);
      await card.getByRole("combobox", { name: "프로젝트" }).selectOption(projectId);
    }
    for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const wallpaper of [false, true]) {
      await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme, conversation_background: { source: wallpaper ? { kind: "live", module: "butler.bloom", params: { colors: "monochrome" } } : { kind: "none" }, overlay: 0 }, wallpaper: { source: wallpaper ? { kind: "live", module: "butler.bloom", params: { colors: "monochrome" } } : { kind: "none" } } }) });
      await page.setViewportSize({ width, height: 1100 });
      await page.reload();
      await page.getByText("입력 오류 과제 초안을 준비했습니다.", { exact: true }).first().waitFor();
      if (!baseline) {
        await card.waitFor();
        await auditCanonCardFocus(page, card);
      }
      await page.screenshot({ path: join(shots, `${baseline ? "before" : "after"}-${width}-${theme}-${wallpaper ? "wallpaper" : "plain"}-draft.png`), animations: "disabled" });
    }
    const pending = await server.api<{ asks: Array<{ ask_id: string; session_id: string; source_turn_id: string }> }>("/pending-asks");
    const id = pending.asks[0]?.ask_id.replace(/^canon:/u, ""); assert(id);
    if (baseline) await server.api(`/canon/proposals/${id}`, { method: "POST", body: JSON.stringify({ outcome: "accepted" }) });
    else {
      await card.getByRole("button", { name: "등록", exact: true }).click();
      await card.getByText("등록함", { exact: true }).waitFor();
      const proposal = await server.api<CanonProposal>(`/canon/proposals/${id}`);
      assert.equal(proposal.state, "applied");
    }
    for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
      await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme, conversation_background: { source: { kind: "none" }, overlay: 0 } }) });
      await page.setViewportSize({ width, height: 1100 }); await page.reload();
      await page.getByText("입력 오류 과제 초안을 준비했습니다.", { exact: true }).first().waitFor();
      if (!baseline) await card.getByText("등록함", { exact: true }).waitFor();
      await page.screenshot({ path: join(shots, `${baseline ? "before" : "after"}-${width}-${theme}-applied.png`) });
    }
    if (!baseline) {
      await card.getByRole("button", { name: "열기", exact: true }).click();
      await page.locator('[data-test-class="canon-epic-detail"]').getByText("입력 후 응답이 사라짐", { exact: true }).waitFor();
      await page.screenshot({ path: join(shots, "after-open-epic.png") });
    }
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width: 1440, height: 1100 });
      await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
      await page.reload();
      await page.locator('[data-test-class~="mac-window"]').waitFor();
      await page.waitForFunction(() => document.documentElement.lang.startsWith("ko"));
      const show = page.getByRole("button", { name: "사이드바 보기", exact: true });
      if (await show.isVisible()) await show.click();
      try { await page.getByRole("button", { name: /프로젝트 대시보드$/u }).first().click(); }
      catch (error) {
        await page.screenshot({ path: join(shots, `${baseline ? "before" : "after"}-sidebar-failure.png`) });
        console.error(await page.getByRole("button").evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label") ?? button.textContent)));
        throw error;
      }
      await page.getByRole("tab", { name: "보드", exact: true }).click();
      await page.locator('[data-canon-epic] [data-test-class="canon-epic-title"]').getByText("입력 후 응답이 사라짐", { exact: true }).waitFor();
      if (!baseline) {
        const bound = page.locator('[data-test-class="canon-bound-chats"]');
        await bound.waitFor(); await auditCanonCardFocus(page, bound);
      }
      await page.screenshot({ path: join(shots, `${baseline ? "before" : "after"}-1440-${theme}-sidebar.png`) });
    }
    await captureRegistrationVariants(page, server, pending.asks[0]!, projectId, shots, baseline);
    await captureDestinationVariants(page, server, pending.asks[0]!, projectId, shots, baseline);
    console.log(JSON.stringify({ result: "PASS", phase: baseline ? "before" : "after", screenshots: baseline ? 32 : 33, draftSelect: !baseline, registerAndOpen: !baseline }));
  } catch (error) {
    console.error(JSON.stringify({ modelCalls: server.stubModelCalls.length, diagnostics: server.diagnostics() }));
    throw error;
  } finally { await context.close(); }
} finally { await browser?.close(); await server.stop(); }
