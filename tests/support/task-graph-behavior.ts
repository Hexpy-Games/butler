import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import type { TaskGraphSnapshot, TaskGraphsPage } from "../../packages/butler-app/client/shared/task-graph-contracts.ts";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import { assertTaskGraphIdle } from "./task-graph-idle.ts";
import { finishGraphWorkers, reviseTaskGraph, advanceGraphPhase, planChildGraph } from "./task-graph-seed.ts";

export async function verifyGraphFades(page: Page) {
  const canvases = page.locator('[data-test-class="task-graph-canvas"]');
  const count = await canvases.count();
  await canvases.evaluateAll(items => items.forEach(el => { el.scrollLeft = 0; }));
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('[data-test-class="task-graph-canvas"]')].every(el => el.dataset.atStart === "true"));
  const rightFades = await canvases.evaluateAll(items => items.map(el => ({
    axis: el.dataset.scrollFade, overflowing: el.dataset.overflowing, atEnd: el.dataset.atEnd,
    size: getComputedStyle(el).getPropertyValue("--scroll-fade-end").trim(), mask: getComputedStyle(el).maskImage,
  })));
  assert.equal(rightFades.length, count);
  for (const fade of rightFades) {
    assert.equal(fade.axis, "x");
    assert.equal(fade.overflowing, "true");
    assert.equal(fade.atEnd, "false");
    assert.notEqual(fade.size, "0px", "the clipped right edge has an active fade");
    assert.notEqual(fade.mask, "none", "the canvas fade mask is applied");
  }
  await canvases.evaluateAll(items => items.forEach(el => { el.scrollLeft = el.scrollWidth; }));
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('[data-test-class="task-graph-canvas"]')].every(el => el.dataset.atEnd === "true"));
  const leftFades = await canvases.evaluateAll(items => items.map(el => ({
    atStart: el.dataset.atStart, size: getComputedStyle(el).getPropertyValue("--scroll-fade-start").trim(),
  })));
  for (const fade of leftFades) {
    assert.equal(fade.atStart, "false");
    assert.notEqual(fade.size, "0px", "the clipped left edge has an active fade");
  }
  await canvases.evaluateAll(items => items.forEach(el => { el.scrollLeft = 0; }));
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('[data-test-class="task-graph-canvas"]')].every(el => el.dataset.atStart === "true"));
}

export async function verifyGraphRevision(page: Page, server: NativeAppServerHandle, graphId: string, runtimeId: string) {
  const requests: string[] = [];
  const record = (request: { url(): string }) => {
    const path = new URL(request.url()).pathname;
    if (/task-graphs?|\/plans\//u.test(path)) requests.push(path);
  };
  page.on("request", record);
  const before = await server.api<TaskGraphSnapshot>(`/plans/${graphId}/task-graph`);
  requests.length = 0;
  await reviseTaskGraph(server.butlerData, graphId);
  const latest = await server.api<TaskGraphSnapshot>(`/plans/${graphId}/task-graph`);
  await emitGraph(page, latest, runtimeId, before.graph_revision);
  await page.waitForFunction(({ id, count }) => document.querySelector(`[data-graph-id="${id}"]`)?.querySelectorAll('[data-test-class="task-graph-card"]').length === count, { id: graphId, count: latest.nodes.length });
  assert.deepEqual(requests, [], "a matching SSE patch causes no refetch");
  await emitGraph(page, latest, runtimeId, before.graph_revision);
  await page.waitForTimeout(100);
  assert.equal(requests.length, 0, "duplicate revisions cause no refetch");
  const recovery = page.waitForResponse(response => decodeURIComponent(new URL(response.url()).pathname) === `/plans/${graphId}/task-graph`);
  await emitGraph(page, { ...latest, graph_revision: `gap:${latest.graph_revision}` }, runtimeId, "missing");
  await recovery;
  assert.equal(requests.length, 1, "a revision gap refetches only the changed graph");
  let previous = latest.graph_revision;
  for (const [phase, label] of [["validation", "Reviewing"], ["reporting", "Reporting"]]) {
    await advanceGraphPhase(server.butlerData, graphId, phase!);
    const next = await server.api<TaskGraphSnapshot>(`/plans/${graphId}/task-graph`);
    await emitGraph(page, next, runtimeId, previous);
    const groups = page.locator('[data-test-class="task-graph-group"]');
    const region = await groups.count() === 1 ? page.locator('[data-test-class="task-graph-section"]') : page.locator(`[data-graph-id="${graphId}"]`);
    await region.getByText(label!, { exact: false }).first().waitFor();
    previous = next.graph_revision;
  }

  page.off("request", record);
  console.log(JSON.stringify({ patchRefetches: 0, gapRefetches: 1, otherGraphRefetches: 0, duplicateRefetches: 0 }));
}

export async function verifyStoppedGraphs(page: Page, server: NativeAppServerHandle, snapshots: TaskGraphSnapshot[], runtimeId: string) {
  await finishGraphWorkers(server.butlerData);
  for (const graph of snapshots) {
    const latest = await server.api<TaskGraphSnapshot>(`/plans/${graph.graph_id}/task-graph`);
    assert.equal(latest.counts.running, 0);
    await emitGraph(page, latest, runtimeId, graph.graph_revision);
  }
  await page.waitForFunction(() => document.querySelectorAll('[data-test-class="task-graph-card"][data-task-status="running"]').length === 0);
  await assertTaskGraphIdle(page, server.butlerData);
}

let changeSequence = 10_000;
async function emitGraph(page: Page, graph: TaskGraphSnapshot, runtimeId: string, previous: string | null) {
  const sequence = ++changeSequence;
  await page.evaluate(({ graph, runtimeId, previous, sequence }) => (window as unknown as { __emitWorkEvent: (event: unknown) => void }).__emitWorkEvent({
    id: sequence, type: "work_model.changed", payload: { ...graph, session_id: runtimeId, plan_id: graph.graph_id, previous_graph_revision: previous, refetch: previous === null, node_order: graph.nodes.map(n => n.task_id), entity_changes: graph.nodes.map(node => ({ type: "upsert", task_id: node.task_id, node })) },
  }), { graph, runtimeId, previous, sequence });
}

export async function verifyPendingSelection(page: Page, graph: TaskGraphSnapshot): Promise<string | undefined> {
  const pending = graph.nodes.find(n => n.session_id === null);
  if (!pending) return;
  const card = page.locator(`[data-task-id="${pending.task_id}"]`);
  await card.click();
  assert.equal(await card.getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("dialog").count(), 0, "an unassigned card only selects");
  return pending.task_id;
}

export async function verifyAttemptHistory(page: Page, graph: TaskGraphSnapshot): Promise<void> {
  const node = graph.nodes.find(n => n.attempts.length>1);
  if (!node) return;
  await page.locator(`[data-task-id="${node.task_id}"]`).click();
  if (node.session_id) {
    const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  }
  const detail=page.locator('[data-test-class="task-graph-detail"]');
  await detail.getByText("attempt 2", { exact:true }).waitFor();
  await detail.getByText(node.attempts[0]!.summary!, { exact:true }).waitFor();
}

export async function verifyStewardHandoff(page: Page, server: NativeAppServerHandle, graph: TaskGraphSnapshot, sessionId: string, runtimeId: string) {
  await planChildGraph(server.butlerData, graph.graph_id);
  const list = await server.api<TaskGraphsPage>(`/sessions/${sessionId}/task-graphs`);
  assert.equal(list.total, 1);
  const child = await server.api<TaskGraphSnapshot>(`/plans/${list.graphs[0]!.graph_id}/task-graph`);
  assert.notEqual(child.graph_id, graph.graph_id);
  const requests: string[] = [];
  const record = (request: { url(): string }) => {
    const path = decodeURIComponent(new URL(request.url()).pathname);
    if (/task-graphs?|\/plans\//u.test(path)) requests.push(path);
  };
  page.on("request", record);
  // No parent tombstone: the server's event cache may not have seen its graph.
  await emitGraph(page, child, runtimeId, null);
  await page.waitForFunction(id => {
    const groups = document.querySelectorAll('[data-test-class="task-graph-group"]');
    return groups.length === 1 && groups[0]?.getAttribute("data-graph-id") === id;
  }, child.graph_id);
  await page.locator(`[data-graph-id="${child.graph_id}"] [data-test-class="task-graph-card"]`).first().waitFor();
  page.off("request", record);
  assert.deepEqual(requests.sort(), [`/sessions/${sessionId}/task-graphs`, `/plans/${child.graph_id}/task-graph`].sort());
  console.log(JSON.stringify({ handoffGraphs: 1, membershipListReads: 1, newGraphReads: 1 }));
}
