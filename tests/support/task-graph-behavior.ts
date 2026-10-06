import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Page } from "playwright";
import type { TaskGraphSnapshot } from "../../packages/butler-app/client/shared/task-graph-contracts.ts";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import { assertTaskGraphIdle } from "./task-graph-idle.ts";
import { finishGraphWorkers } from "./task-graph-seed.ts";

export async function verifyGraphFades(page: Page) {
  const canvas = page.locator('[data-test-class="task-graph-canvas"]').first();
  await canvas.evaluate(el => { el.scrollLeft = 0; });
  await page.waitForFunction(() => document.querySelector('[data-test-class="task-graph-canvas"]')?.getAttribute("data-at-start") === "true");
  assert.equal(await canvas.getAttribute("data-at-end"), "false");
  await canvas.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await page.waitForFunction(() => document.querySelector('[data-test-class="task-graph-canvas"]')?.getAttribute("data-at-end") === "true");
  assert.equal(await canvas.getAttribute("data-at-start"), "false");
  await canvas.evaluate(el => { el.scrollLeft = 0; });
}

export async function verifyGraphRevision(page: Page, server: NativeAppServerHandle, graphId: string, runtimeId: string) {
  const requests: string[] = [];
  const record = (request: { url(): string }) => {
    const path = new URL(request.url()).pathname;
    if (/task-graphs?|\/plans\//u.test(path)) requests.push(path);
  };
  page.on("request", record);
  const db = new Database(join(server.butlerData, "agent-runtime/btcc.sqlite"));
  try {
    db.query("UPDATE btcc_guided_work_plan_revisions SET objective='Updated release' WHERE plan_revision_id=?").run(graphId);
    db.query("UPDATE btcc_guided_works SET updated_at='2026-10-03T00:00:00Z' WHERE current_plan_revision_id=?").run(graphId);
  } finally { db.close(); }
  const latest = await server.api<TaskGraphSnapshot>(`/plans/${graphId}/task-graph`);
  await emitGraph(page, latest, runtimeId);
  await page.getByText("Updated release", { exact: true }).first().waitFor();
  assert.deepEqual(requests, [`/plans/${graphId}/task-graph`], "an SSE revision must fetch only its changed graph");
  await emitGraph(page, latest, runtimeId);
  await page.waitForTimeout(100);
  assert.equal(requests.length, 1, "duplicate revisions cause no refetch");
  page.off("request", record);
  console.log(JSON.stringify({ revisionRefetches: 1, otherGraphRefetches: 0, duplicateRefetches: 0 }));
}

export async function verifyStoppedGraphs(page: Page, server: NativeAppServerHandle, snapshots: TaskGraphSnapshot[], runtimeId: string) {
  finishGraphWorkers(server.butlerData);
  for (const graph of snapshots) {
    const latest = await server.api<TaskGraphSnapshot>(`/plans/${graph.graph_id}/task-graph`);
    assert.equal(latest.counts.running, 0);
    await emitGraph(page, latest, runtimeId);
  }
  await page.waitForFunction(() => document.querySelectorAll('[data-test-class="task-graph-card"][data-task-status="running"]').length === 0);
  await assertTaskGraphIdle(page, server.butlerData);
}

async function emitGraph(page: Page, graph: TaskGraphSnapshot, runtimeId: string) {
  await page.evaluate(({ graph, runtimeId }) => (window as unknown as { __emitWorkEvent: (event: unknown) => void }).__emitWorkEvent({
    id: 1000 + graph.event_seq, type: "work_model.changed", payload: { session_id: runtimeId, plan_id: graph.graph_id, graph_revision: graph.graph_revision },
  }), { graph, runtimeId });
}

export async function verifyPendingSelection(page: Page, graph: TaskGraphSnapshot) {
  const pending = graph.nodes.find(n => n.session_id === null);
  if (!pending) return;
  const card = page.locator(`[data-task-id="${pending.task_id}"]`);
  await card.click();
  assert.equal(await card.getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("dialog").count(), 0, "an unassigned card only selects");
}
