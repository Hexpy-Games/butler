// test-category: race
import { settleCrop } from "./canon-registration-crops.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { EpicDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";
export type DeleteTool = { name: string; arguments: Record<string, unknown> };
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export async function captureDeleteCards(page: Page, server: NativeAppServerHandle, project: string, name: string, shots: string, arm: (tool: DeleteTool) => void) {
  const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
  const epic = await server.api<EpicDetail>(`/projects/${project}/canon/epics`, post({ title: "삭제할 이전 과제" }));
  if (baseline) await page.route("**/canon/proposals/*", async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: new URL(server.url).origin } });
    const body = await response.json();
    // Reconstruct the previous projection for the saved UI bundle: it included
    // delete targets in the generic Epic list, with no label tying them to deletion.
    if (body.data?.state === "open" && body.data.changes.some((change: { op: string }) => change.op === "epic.delete")
      && !body.data.epics.some((item: { title: string }) => item.title === epic.title)) {
      body.data.epics.push({ title: epic.title, description: epic.description, tags: epic.tags, attachments: epic.attachments });
    }
    await route.fulfill({ response, json: body });
  });
  const chat = await server.api<{ session: { id: string } }>("/sessions", post({ kind: "project", project_id: project, title: "과제 변경 검토" }));
  const deletion = { op: "epic.delete", id: epic.id, expected_revision: epic.revision };
  arm({ name: "canon_propose", arguments: { project_id: project, summary: "과제 교체", changes: [{ op: "epic.create", title: "새로 등록할 과제" }, deletion] } });
  await page.evaluate(id => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({ schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: false, right_open: false })), chat.session.id);
  await page.reload();
  const compact = page.locator('[data-slot="composer-compact-preview"]');
  if (await compact.isVisible()) await compact.click();
  await page.locator('[contenteditable="true"]').fill("과제 변경을 제안해 줘");
  await page.getByRole("button", { name: "전송", exact: true }).click();
  const mixed = page.locator('[data-test-class="canon-proposal-card"][data-state="open"]');
  await mixed.getByRole("button", { name: baseline ? "등록" : "과제 등록 및 삭제", exact: true }).waitFor();
  assert.equal(await mixed.getByText("삭제할 이전 과제", { exact: true }).count(), 1);
  await mixed.getByText("새로 등록할 과제", { exact: true }).waitFor();
  await settleCrop(page, mixed);
  await mixed.screenshot({ path: join(shots, `${name}-mixed-card.png`), animations: "disabled" });
  const pending = await server.api<{ asks: Array<{ ask_id: string; source_turn_id: string }> }>(`/sessions/${chat.session.id}/pending-asks`);
  const anchor = pending.asks[0]!; assert(anchor);
  const draft = async (changes: unknown[]) => (await server.api<{ ask_id: string }>(`/sessions/${chat.session.id}/canon/propose`, post({ turn_id: anchor.source_turn_id, call_id: `delete-${changes[0] && Date.now()}`, apply: false, arguments: { project_id: project, summary: "과제 변경", changes } }))).ask_id.slice(6);
  const onlyId = await draft([deletion]);
  await page.reload();
  const only = page.locator(`[data-proposal-id="${onlyId}"]`);
  await only.getByRole("button", { name: baseline ? "반영" : "과제 삭제", exact: true }).waitFor();
  assert.equal(await only.getByText("삭제할 이전 과제", { exact: true }).count(), 1);
  await settleCrop(page, only);
  await only.screenshot({ path: join(shots, `${name}-delete-card.png`), animations: "disabled" });
  const editId = await draft([{ op: "epic.edit", id: epic.id, expected_revision: epic.revision, description: "변경된 내용" }]);
  await server.api(`/canon/proposals/${editId}`, post({ outcome: "accepted" }));
  const current = await server.api<EpicDetail>(`/canon/epics/${epic.id}`);
  await server.api(`/canon/epics/${epic.id}`, { method: "DELETE", body: JSON.stringify({ expected_revision: current.revision }) });
  await page.reload();
  await page.locator(`[data-proposal-id="${editId}"]`).getByRole("button", { name: "열기", exact: true }).click();
  const missing = baseline ? page.locator('[data-slot="management-page-aside"]').locator('[data-indeterminate="true"]') : page.getByText("이미 삭제된 과제입니다", { exact: true });
  await missing.waitFor();
  assert.equal(await page.locator('[data-slot="management-page-aside"]').locator('[data-indeterminate="true"]').count(), baseline ? 1 : 0);
  await page.locator('[data-slot="management-page-aside"]').screenshot({ path: join(shots, `${name}-missing.png`), animations: "disabled" });
}

export async function captureDeleteMenu(page: Page, shots: string, name: string) {
  const boxes = await Promise.all([page.getByRole("menu").boundingBox(), page.getByRole("tooltip").filter({ hasText: "진행 중에는 삭제할 수 없습니다" }).boundingBox()]);
  assert(boxes.every(Boolean));
  const left = Math.max(0, Math.floor(Math.min(...boxes.map(box => box!.x)) - 4));
  const top = Math.max(0, Math.floor(Math.min(...boxes.map(box => box!.y)) - 4));
  const right = Math.min(page.viewportSize()!.width, Math.ceil(Math.max(...boxes.map(box => box!.x + box!.width)) + 4));
  const bottom = Math.min(page.viewportSize()!.height, Math.ceil(Math.max(...boxes.map(box => box!.y + box!.height)) + 4));
  await page.screenshot({ path: join(shots, `${name}-crop.png`), clip: { x: left, y: top, width: right - left, height: bottom - top }, animations: "disabled" });
}
