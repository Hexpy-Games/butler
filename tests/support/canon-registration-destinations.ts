import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import { auditCanonCardFocus, auditCanonFacts } from "./canon-registration-cards.ts";

/** A project's chat must still name and expose a different proposed destination. */
export async function captureDestinationVariants(page: Page, server: NativeAppServerHandle, anchor: { session_id: string; source_turn_id: string }, project: string, shots: string, baseline: boolean) {
  const other = await server.api<{ project: { id: string } }>("/projects", { method: "POST", body: JSON.stringify({ source: "scratch", display_name: "다른 제품" }) });
  const space = await server.api<{ space: { revision: number } }>("/navigation");
  await server.api("/space/relocations", { method: "POST", body: JSON.stringify({ expectedRevision: space.space.revision, operationId: "canon-card-destination", sessionId: anchor.session_id, targetKey: `p:${project}`, position: "inside" }) });
  const propose = async (changes: unknown[]) => {
    const result = await server.api<{ ask_id: string }>(`/sessions/${anchor.session_id}/canon/propose`, { method: "POST", body: JSON.stringify({ turn_id: anchor.source_turn_id, call_id: "destination", apply: false,
      arguments: { project_id: other.project.id, summary: "변경 내용", changes },
    }) });
    return result.ask_id.replace(/^canon:/u, "");
  };
  const create = await propose([{ op: "epic.create", title: "다른 프로젝트의 과제" }]);
  await captures(page, server, create, other.project.id, shots, baseline, "project-destination");
  if (!baseline) {
    const card = page.locator(`[data-proposal-id="${create}"]`);
    await card.getByRole("combobox", { name: "프로젝트", exact: true }).selectOption(project);
    await card.getByRole("button", { name: "등록", exact: true }).click();
    await card.getByText("등록함", { exact: true }).waitFor();
  } else await server.api(`/canon/proposals/${create}`, { method: "POST", body: JSON.stringify({ outcome: "accepted", project_id: project }) });
  const board = await server.api<{ backlog: Array<{ title: string }> }>(`/projects/${project}/canon`);
  assert(board.backlog.some(epic => epic.title === "다른 프로젝트의 과제"));
  const epic = await server.api<{ id: string; revision: number }>(`/projects/${other.project.id}/canon/epics`, { method: "POST", body: JSON.stringify({ title: "이동할 과제" }) });
  const plan = await server.api<{ id: string }>(`/projects/${other.project.id}/canon/plans`, { method: "POST", body: JSON.stringify({ title: "다음 릴리스" }) });
  const move = await propose([{ op: "epic.move", id: epic.id, expected_revision: epic.revision, plan_id: plan.id }]);
  await captures(page, server, move, other.project.id, shots, baseline, "move-destination");
}
async function captures(page: Page, server: NativeAppServerHandle, id: string, project: string, shots: string, baseline: boolean, variant: string) {
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const wallpaper of [false, true]) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme, conversation_background: { source: wallpaper ? { kind: "live", module: "butler.bloom", params: { colors: "monochrome" } } : { kind: "none" }, overlay: 0 } }) });
    await page.setViewportSize({ width, height: 1100 }); await page.reload();
    const card = page.locator(`[data-proposal-id="${id}"]`);
    await card.waitFor(); await card.scrollIntoViewIfNeeded();
    if (!baseline) {
      assert.equal(await card.getByRole("combobox", { name: "프로젝트", exact: true }).inputValue(), project);
      assert.equal(await card.locator("select option:checked").textContent(), "다른 제품");
      assert.equal(await card.getByText("프로젝트", { exact: true }).count(), 1, "one visible project label");
      if (variant === "move-destination") {
        await card.getByText("이동할 과제", { exact: true }).waitFor();
        await card.getByRole("group", { name: "현재 계획", exact: true }).getByText("백로그", { exact: true }).waitFor();
        await card.getByRole("group", { name: "대상 계획", exact: true }).getByText("다음 릴리스", { exact: true }).waitFor();
        assert.equal(await card.getByText("과제 이동", { exact: true }).count(), 0);
      }
      await auditCanonFacts(card);
      await auditCanonCardFocus(page, card);
    }
    await page.screenshot({ path: join(shots, `${baseline ? "before" : "after"}-${width}-${theme}-${wallpaper ? "wallpaper" : "plain"}-${variant}.png`), animations: "disabled" });
  }
}
