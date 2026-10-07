// Stub-backed E2E: real App, native graph/document reads and seeded worker sessions.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { installTaskSessionReplay } from "../support/task-graph-session-replay.ts";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { installWorkReplay } from "../support/delegated-work-replay.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { verifyGraphFades, verifyGraphRevision, verifyPendingSelection, verifyStoppedGraphs } from "../support/task-graph-behavior.ts";
import { assertTaskGraphClocks, installGraphActivityCounters } from "../support/task-graph-idle.ts";
import { seedTaskGraphs, type SeedState } from "../support/task-graph-seed.ts";
import type { TaskGraphSnapshot, TaskGraphsPage } from "../../packages/butler-app/client/shared/task-graph-contracts.ts";

const scenarios: { states: SeedState[]; tasks: number; matrix: boolean }[] = [
  { states: ["running"], tasks: 5, matrix: true },
  { states: ["running", "failed"], tasks: 5, matrix: true },
  { states: ["cancelled", "done", "waiting", "failed", "running", "running"], tasks: 5, matrix: true },
  ...[[], ["running"], ["failed"], ["cancelled"], ["waiting"], ["done"]].map(states => ({ states: states as SeedState[], tasks: states.length ? states[0] === "running" ? 1 : 5 : 0, matrix: false })),
  { states: ["running"], tasks: 2, matrix: false },
  { states: ["running"], tasks: 16, matrix: false },
];
const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
if (output) mkdirSync(output, { recursive: true });
const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const browser = await launchSmokeBrowser();
const context = await browser.newContext({ reducedMotion: "reduce" });
const pageErrors: string[] = [];
try {
  for (const { states, tasks, matrix } of baseline ? scenarios.slice(0, 1) : scenarios) {
    const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
    try {
      const { session } = await server.api<{ session: { id: string; session_hint: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Release conversation" }) });
      const parent = await server.api<SessionView>(`/session-view?session_id=${session.id}`);
      seedTaskGraphs(server.butlerData, states, tasks, session.session_hint);
      const list = await server.api<TaskGraphsPage>(`/sessions/${session.id}/task-graphs`);
      assert.equal(list.total, states.length);
      const snapshots = await Promise.all(list.graphs.map(g => server.api<TaskGraphSnapshot>(`/plans/${g.graph_id}/task-graph`)));
      for (const width of matrix ? [1280, 375] : [1280]) for (const theme of matrix ? ["light", "dark"] : ["light"]) for (const language of matrix ? ["ko", "en"] : ["en"]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 900 });
        page.on("pageerror", error => { pageErrors.push(error.message); console.error("task graph page error:", error.message); });
        page.on("console", message => { if (message.type() === "error") console.error("task graph console:", message.text()); });
        try {
          await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme }) });
          await installWorkReplay(page);
          await page.addInitScript(id => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({ schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: false, right_open: true })), session.id);
          await installTaskSessionReplay(page, parent, snapshots);
          await installGraphActivityCounters(page);
          await server.signIn(page);
          await page.goto(server.url);
          const show = page.getByRole("button", { name: language === "ko" ? "오른쪽 패널 보기" : "Show right panel", exact: true });
          const inspector = page.locator('[data-test-class~="right-inspector"]');
          await inspector.waitFor({ state: "attached" });
          if (!await inspector.isVisible()) await show.click();
          await inspector.waitFor();
          const tab = page.getByRole("button", { name: language === "ko" ? "작업" : "Tasks", exact: true });
          if (baseline) {
            if (output) await page.screenshot({ path: `${output}/before-${states.length}-${width}-${theme}-${language}.png`, animations: "disabled" });
            continue;
          }
          const labels = await inspector.locator('button[aria-current], button').allTextContents();
          assert.equal(labels[0], language === "ko" ? "요약" : "Summary");
          assert.equal(labels[1], language === "ko" ? "작업" : "Tasks");
          assert.equal(await inspector.locator('[data-test-class="task-graph-card"]').count(), 0);
          if (output) await page.screenshot({ path: `${output}/summary-after-${states.length}-${width}-${theme}-${language}.png`, animations: "disabled" });
          await tab.click();
          if (!states.length) {
            await page.getByText("No tasks yet", { exact: true }).waitFor();
            assert.equal(await page.locator('[data-test-class="task-graph-card"]').count(), 0);
            continue;
          }
          const groups = page.locator('[data-test-class="task-graph-group"]');
          await page.waitForFunction(count => document.querySelectorAll('[data-test-class="task-graph-group"]').length === count, states.length);
          assert.equal(await groups.count(), states.length);
          const priority = { running: 0, failed: 1, waiting: 2, done: 3, cancelled: 4 };
          const ordered = snapshots.toSorted((a, b) => priority[a.state] - priority[b.state]);
          assert.deepEqual(await groups.evaluateAll(elements => elements.map(el => el.getAttribute("data-graph-id"))), ordered.map(g => g.graph_id));
          for (let i = 0; i < ordered.length; i++) {
            assert.equal(await groups.nth(i).getAttribute("data-open"), String(states.length === 1 || ["running", "failed"].includes(ordered[i]!.state)));
          }
          if (states.length === 1) assert.equal(await groups.locator('[aria-expanded]').count(), 0);
          const open = snapshots.filter(g => g.state === "running" || g.state === "failed" || states.length === 1);
          assert.equal(await page.locator('[data-test-class="task-graph-card"]').count(), open.reduce((n, g) => n + g.totals.nodes, 0));
          await page.waitForFunction(count => document.querySelectorAll('path[data-edge]').length === count, open.reduce((n, g) => n + g.totals.edges, 0));
          if (width === 375) {
            assert.equal(await page.locator('[data-test-class="task-graph-canvas"]').count(), 0);
            assert.equal(await page.locator('[data-test-class="task-graph-group"] svg circle[data-status]').count(), open.reduce((n, g) => n + g.totals.nodes, 0));
          }
          // The shared spinner intentionally fades under reduced motion; the activity
          // ring rests, and no remaining graph animation may rotate or move geometry.
          assert(await page.locator('[data-test-class="task-graph-section"]').evaluate(el =>
            [...el.querySelectorAll('[data-activity="running"]')].every(card => getComputedStyle(card, "::after").animationIterationCount === "0") &&
            el.getAnimations({ subtree: true }).filter(a => a.playState === "running").every(a =>
              (a.effect as KeyframeEffect).getKeyframes().every(frame => !("transform" in frame)))), "reduced motion kept a graph ring or geometry moving");
          if (width === 1280 && tasks > 1) await verifyGraphFades(page);
          const selected = page.locator('[data-test-class="task-graph-card"][aria-pressed="true"]');
          const orderedGraphs = ordered.map(graph => snapshots.find(snapshot => snapshot.graph_id === graph.graph_id)!);
          let candidates = expectedDefaultCandidates(orderedGraphs);
          let defaultSelectedId = await selected.getAttribute("data-task-id");
          assert(candidates.some(node => node.task_id === defaultSelectedId),
            `default selection follows running, failed, blocked, then last finished for ${states.length} graphs`);
          if (output && matrix) await page.screenshot({ path: `${output}/after-${states.length}-${width}-${theme}-${language}.png`, animations: "disabled" });
          if (!matrix && states.length === 1 && states[0] === "running" && tasks === 1) {
            await verifyStoppedGraphs(page, server, snapshots, session.session_hint);
            const refreshed = await Promise.all(list.graphs.map(graph => server.api<TaskGraphSnapshot>(`/plans/${graph.graph_id}/task-graph`)));
            candidates = expectedDefaultCandidates(refreshed);
            const candidateIds = candidates.map(node => node.task_id);
            await page.waitForFunction(ids => ids.includes(document.querySelector('[data-test-class="task-graph-card"][aria-pressed="true"]')?.getAttribute("data-task-id") ?? ""), candidateIds);
            defaultSelectedId = await page.locator('[data-test-class="task-graph-card"][aria-pressed="true"]').getAttribute("data-task-id");
            assert(candidateIds.includes(defaultSelectedId!),
              "an untouched default selection follows the last finished task after running work completes");
          }
          const expected = candidates.find(node => node.task_id === defaultSelectedId)!;
          await selected.focus();
          const owner = snapshots.find(g => g.nodes.some(n => n.task_id === expected.task_id))!;
          const last = owner.nodes.at(-1)?.task_id === expected.task_id;
          const first = owner.nodes[0]?.task_id === expected.task_id;
          await page.keyboard.press(width === 375 ? last ? "ArrowUp" : "ArrowDown" : first ? "ArrowRight" : "ArrowLeft");
          assert.equal(await page.locator('[data-test-class="steward-observer-dialog"]').count(), 0);
          const selectedId = await selected.getAttribute("data-task-id");
          if (owner.nodes.length > 1) assert.notEqual(selectedId, expected.task_id, "arrow keys move selection");
          assert.equal(await selected.evaluate(el => el === document.activeElement), true, "arrow keys move focus with selection");
          const selectedNode = snapshots.flatMap(g => g.nodes).find(n => n.task_id === selectedId)!;
          const observerRequest = selectedNode.session_id ? page.waitForRequest(request => {
            const url = new URL(request.url());
            return url.pathname === "/session-view" && url.searchParams.get("session_id") === selectedNode.session_id;
          }) : undefined;
          await page.keyboard.press("Enter");
          const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
          if (observerRequest) {
            await observerRequest;
            await dialog.waitFor();
            assert(!/\bWork\b|Steward|스튜어드|위임|delegate_to_/u.test(await dialog.innerText()));
            if (output) await page.screenshot({ path: `${output}/observer-${states.length}-${width}-${theme}-${language}.png` });
            await page.keyboard.press("Escape");
            await page.locator(`[data-task-id="${selectedId}"]`).click();
            await dialog.waitFor();
            await page.keyboard.press("Escape");
          } else assert.equal(await dialog.count(), 0);
          const tile = page.locator('[data-test-class="task-graph-detail"]').getByRole("button", { name: language === "ko" ? "작업 문서" : "Task document", exact: true });
          const documentRequest = page.waitForRequest(request => new URL(request.url()).pathname === `/tasks/${encodeURIComponent(selectedId!)}/document`);
          await tile.click();
          await documentRequest;
          await page.getByRole("dialog").waitFor();
          assert(!/\bWork\b|Steward|스튜어드|위임|delegate_to_/u.test(await page.getByRole("dialog").innerText()));
          await page.getByRole("dialog").getByRole("heading", { name: language === "ko" ? "목표" : "Goal", exact: true }).waitFor();
          if (output) await page.screenshot({ path: `${output}/document-${states.length}-${width}-${theme}-${language}.png` });
          await page.keyboard.press("Escape");
          const explicitSelection = await verifyPendingSelection(page, open[0]!);
          if (states.length > 1) {
            const group = groups.first();
            await group.locator('[aria-expanded="true"]').click();
            assert.equal(await group.getAttribute("data-open"), "false");
            assert.equal(await group.locator('[data-test-class="task-graph-card"]').count(), 0);
            await group.locator('[aria-expanded="false"]').click();
            assert.equal(await group.getAttribute("data-open"), "true");
          }
          assert(!/\bWork\b|Steward|스튜어드|위임|delegate_to_/u.test(await page.locator('[data-test-class="task-graph-section"]').innerText()));
          if (matrix && width === 1280 && theme === "light" && language === "en") await assertTaskGraphClocks(page, snapshots.filter(g => g.counts.running > 0).length);
          if (width === 375 && theme === "dark" && language === "en") {
            await verifyGraphRevision(page, server, open[0]!.graph_id, session.session_hint);
            await verifyStoppedGraphs(page, server, snapshots, session.session_hint);
            if (explicitSelection) assert.equal(await page.locator('[data-test-class="task-graph-card"][aria-pressed="true"]').getAttribute("data-task-id"), explicitSelection,
              "an explicit user selection survives later graph revisions");
          }
          console.log(JSON.stringify({ graphs: states.length, width, theme, language, cards: open.reduce((n, g) => n + g.totals.nodes, 0), edges: open.reduce((n, g) => n + g.totals.edges, 0) }));
        } finally { await page.close(); }
      }
    } finally { await server.stop(); }
  }
  assert.deepEqual(pageErrors, [], "the graph and its dialogs must render without page errors");
} finally { await context.close(); await browser.close(); }

function expectedDefaultCandidates(graphs: TaskGraphSnapshot[]): TaskGraphSnapshot["nodes"] {
  const nodes = graphs.flatMap(graph => graph.nodes);
  for (const status of ["running", "failed", "blocked"] as const) {
    const candidates = nodes.filter(node => node.status === status);
    if (candidates.length) return candidates;
  }
  const finished = nodes.filter(node => node.status === "completed" || node.status === "cancelled");
  if (!finished.length) return [nodes[0]!];
  const latest = Math.max(...finished.map(node => finishedTime(node.finished_at)));
  return finished.filter(node => finishedTime(node.finished_at) === latest);
}

function finishedTime(value: string | null): number {
  const parsed = Date.parse(value ?? "1970-01-01");
  return Number.isFinite(parsed) ? parsed : 0;
}
