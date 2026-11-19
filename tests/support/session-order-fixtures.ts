// Real gateway seeding; model streams stay open until teardown. Only the unrelated
// subtask projection is replayed to exercise section adjacency in the same screen.
import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { CanonQueueEdit, CanonQueueView } from "../../packages/butler-app/client/shared/canon-queue-contracts.ts";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { subtaskFixtures } from "./session-subtasks-fixtures.ts";

export const postOrder = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
export const readOrder = (host: NativeAppServerHandle, id: string) => host.api<CanonQueueView>(`/sessions/${encodeURIComponent(id)}/canon/queue`);
export const orderItems = (view: CanonQueueView) => view.chains.flatMap(chain => chain.steps.flatMap(step => step.items));
export const orderShape = (view: CanonQueueView) => view.chains.map(chain => chain.steps.map(step => step.items.map(item => item.epic_id)));
export async function orderChat(host: NativeAppServerHandle, title: string) {
  return (await host.api<{ session: { id: string } }>("/sessions", postOrder({ kind: "chat", title }))).session.id;
}
export async function seedOrderPlan(host: NativeAppServerHandle, count = 5) {
  const { project } = await host.api<{ project: { id: string } }>("/projects", postOrder({ source: "scratch", display_name: "진행 순서 확인" }));
  const prefix = `/projects/${project.id}/canon`;
  const plan = await host.api<{ id: string }>(`${prefix}/plans`, postOrder({ title: "발표 준비" }));
  const epics: { id: string; title: string }[] = [];
  for (const title of ["자료 조사", "보고서 작성", "발표 자료", "발표 대본", "검토"].slice(0, count)) {
    epics.push(await host.api(`${prefix}/epics`, postOrder({ title, plan_id: plan.id, assignee: "app-user" })));
  }
  const current = await host.api<{ revision: number }>(`/canon/plans/${plan.id}`);
  await host.api(`/canon/plans/${plan.id}/order`, postOrder({ expected_revision: current.revision, work_ids: epics.map(epic => epic.id) }));
  return { plan, epics };
}
export async function requestOrder(host: NativeAppServerHandle, id: string, body: unknown) {
  return host.api(`/sessions/${encodeURIComponent(id)}/canon/queue`, postOrder(body));
}
export async function apiOrderEdit(host: NativeAppServerHandle, id: string, input: Omit<CanonQueueEdit, "expected_graph_revision">) {
  const view = await readOrder(host, id);
  return host.api<CanonQueueView>(`/sessions/${encodeURIComponent(id)}/canon/queue/edits`, postOrder({ ...input, expected_graph_revision: view.graph_revision }));
}
export async function waitOrder(host: NativeAppServerHandle, id: string, ready: (view: CanonQueueView) => boolean) {
  const until = Date.now() + 30_000;
  for (;;) {
    const view = await readOrder(host, id);
    if (ready(view)) return view;
    assert(Date.now() < until, `order did not settle: ${JSON.stringify(view)}`);
    await new Promise(done => setTimeout(done, 100));
  }
}
export async function stopOrderTurn(host: NativeAppServerHandle, id: string) {
  const until = Date.now() + 30_000;
  for (;;) {
    const { turns } = await host.api<{ turns: { id: string; state: string }[] }>(`/turns?chat_id=${encodeURIComponent(id)}`);
    const active = turns.find(turn => ["running", "thinking", "streaming", "waiting_for_tool"].includes(turn.state));
    if (active) { await host.api(`/turns/${active.id}/cancel`, postOrder({})); return; }
    assert(Date.now() < until, "no cancellable step turn");
    await new Promise(done => setTimeout(done, 100));
  }
}
export async function installOrderPage(page: Page, active: string, lang: "ko" | "en") {
  await page.addInitScript(id => {
    localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({ schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: false, right_open: false }));
  }, active);
  await page.route("**/session-view?**", async route => {
    if (new URL(route.request().url()).searchParams.get("session_id") !== active) return route.continue();
    const response = await route.fetch({ headers: { ...await route.request().allHeaders(), origin: new URL(route.request().url()).origin } });
    assert(response.ok(), `session view forward failed: ${response.status()}`);
    const body = await response.json() as { data: SessionView };
    return route.fulfill({ response, json: { ...body, data: { ...body.data, subtasks: subtaskFixtures(lang).slice(0, 1) } } });
  });
}
/** Offline focus harness reads the same complete item contract as the native smoke. */
export function sessionOrderFocusResponse(path: string): CanonQueueView | undefined {
  const match = path.match(/^\/sessions\/([^/]+)\/canon\/queue$/u);
  if (!match) return undefined;
  const item = (id: string, title: string) => ({ epic_id: id, title, canon_status: "planned" as const, state: "waiting" as const,
    progress: { epic_id: id, running: false, stage: null, stage_history: [], actions: [], disposition: null, counts: { completed: 0, total: 0 } } });
  return { session_id: decodeURIComponent(match[1]!), graph_revision: 1, plan: null, counts: { running: 0, failed: 0, held: 0, waiting: 3 },
    chains: [{ chain_id: "focus-order", origin: "user_message", steps: [
      { index: 0, items: [item("focus-order-a", "자료 조사"), item("focus-order-b", "보고서 작성")] },
      { index: 1, items: [item("focus-order-c", "발표 자료")] },
    ] }] };
}
