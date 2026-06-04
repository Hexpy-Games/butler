import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatWorkerActivityElapsed,
  summarizeWorkerShellWorkBlock,
  summarizeWorkerShellActivity,
  workerActivityUpdateForShellCommand,
  withWorkerActivityHeartbeat,
  workerEvidenceStatusLine,
  workerEvidenceStatusLineForCommand,
  workerPlanningStatusLine,
  workerReportingStatusLine,
  type WorkerActivityUpdate,
} from "../../packages/butler-agent/src/integrations/providers/provider.ts";

const root = process.cwd();

test("worker shell activity maps commands to safe FSM phases", () => {
  expect(summarizeWorkerShellActivity("rg -n \"worker\" src")).toEqual({
    phase: "executing",
    semanticPhase: "inspecting",
    actionKind: "search",
    statusLine: "Inspecting: searching project files.",
  });
  expect(summarizeWorkerShellActivity("sed -n '1,80p' README.md")).toEqual({
    phase: "executing",
    semanticPhase: "inspecting",
    actionKind: "read_file",
    statusLine: "Inspecting: reading README.md.",
  });
  expect(summarizeWorkerShellActivity("printf 'a\\nb' | sed 's/a/b/'")).toEqual({
    phase: "executing",
    semanticPhase: "executing",
    actionKind: "run_command",
    statusLine: "Executing: running the worker step.",
  });
  expect(summarizeWorkerShellActivity("bun run typecheck")).toEqual({
    phase: "verifying",
    semanticPhase: "verifying",
    actionKind: "typecheck",
    statusLine: "Verifying: running type checks.",
  });
  expect(summarizeWorkerShellActivity("git status --short")).toEqual({
    phase: "verifying",
    semanticPhase: "verifying",
    actionKind: "git_status",
    statusLine: "Verifying: checking workspace state.",
  });
});

test("worker shell activity exposes a durable work block title for the UI", () => {
  const update = workerActivityUpdateForShellCommand(
    "sed -n '1,80p' README.md",
    "call-readme",
    "ko",
  );

  expect(update.phase).toBe("executing");
  expect(update.currentTitle).toBe("README.md 파일을 읽어 분석합니다.");
  expect(update.workBlock).toMatchObject({
    id: "worker-shell-call-readme",
    label: "README.md 파일을 읽어 분석합니다.",
    state: "running",
    rows: [
      {
        safe_tool_name: "Bash",
        safe_input_label: "sed -n '1,80p' README.md",
        work_block_label: "README.md 파일을 읽어 분석합니다.",
      },
    ],
  });

  expect(summarizeWorkerShellWorkBlock(
    "bun run typecheck",
    "call-typecheck",
    "en",
    "delivered",
  )).toMatchObject({
    label: "Running validation checks.",
    state: "delivered",
    rows: [{ state: "delivered" }],
  });
  expect(summarizeWorkerShellWorkBlock(
    "nl -ba supabase/functions/verify-purchase/index.ts | sed -n '220,420p' printf '\\n---\\n' nl -ba supabase/functions/verify-purchase/index.ts | sed -n '420,579p'",
    "call-nl-index",
    "ko",
    "running",
  ).label).toBe("index.ts 파일을 읽어 분석합니다.");
});

test("worker activity heartbeat status lines make long model waits visible", () => {
  expect(formatWorkerActivityElapsed(30_100)).toBe("30s");
  expect(formatWorkerActivityElapsed(90_500)).toBe("1m 30s");
  expect(formatWorkerActivityElapsed(300_000)).toBe("5m");
  expect(workerPlanningStatusLine(0)).toBe("Planning: choosing the worker step path.");
  expect(workerPlanningStatusLine(30_000)).toBe("Planning: still choosing the worker step path (30s).");
  expect(workerEvidenceStatusLine(0)).toBe("Consolidating: reading worker evidence.");
  expect(workerEvidenceStatusLine(120_000)).toBe("Consolidating: still reading worker evidence (2m).");
  expect(workerEvidenceStatusLineForCommand("sed -n '1,80p' README.md", 0)).toBe(
    "Consolidating: reviewing README.md.",
  );
  expect(workerReportingStatusLine(0)).toBe("Reporting: composing the worker result.");
  expect(workerReportingStatusLine(61_000)).toBe("Reporting: still composing the worker result (1m 1s).");
});

test("worker activity heartbeat refreshes durable activity during a pending model wait", async () => {
  const updates: WorkerActivityUpdate[] = [];
  const result = await withWorkerActivityHeartbeat(
    (update) => {
      updates.push(update);
    },
    "consolidating",
    workerEvidenceStatusLine,
    () => new Promise((resolve) => setTimeout(() => resolve("done"), 25)),
    5,
  );

  expect(result).toBe("done");
  expect(updates.length).toBeGreaterThanOrEqual(2);
  expect(updates.every((update) => update.phase === "consolidating")).toBe(true);
  expect(
    updates.some((update) => update.statusLine.startsWith("Consolidating: still reading worker evidence")),
  ).toBe(true);
});

test("worker runner refreshes activity while waiting on model continuation", () => {
  const provider = readFileSync(join(root, "packages/butler-agent/src/integrations/providers/provider.ts"), "utf8");

  expect(provider).toContain("withWorkerActivityHeartbeat");
  expect(provider).toContain("WORKER_ACTIVITY_HEARTBEAT_MS");
  expect(provider).toContain("DEFAULT_WORKER_TOOL_ROUNDS = 24");
  expect(provider).toContain("Batch read-only discovery into a small number of targeted commands.");
  expect(provider).toContain("maxToolRounds: DEFAULT_WORKER_TOOL_ROUNDS");
  expect(provider).toMatch(/withWorkerActivityHeartbeat\(\s*options\.onActivity,\s*"planning",\s*workerPlanningStatusLine,/);
  expect(provider).toMatch(
    /withWorkerActivityHeartbeat\(\s*options\.onActivity,\s*"consolidating",\s*evidenceStatusLine,[\s\S]*previous_response_id: response\.id/,
  );
  expect(provider).toMatch(/instructions:\s*finalNoToolInstructions\(options\.instructions\)/);
  expect(provider).toMatch(/workerReportingStatusLine/);
});

test("dispatch keeps worker in planning until the worker runner emits execution", () => {
  const dispatch = readFileSync(join(root, "packages/butler-agent/scripts/dispatch.sh"), "utf8");
  const planningIndex = dispatch.indexOf(
    'write_worker_activity "planning" "Planning: structuring the worker phase and step path."',
  );
  const runnerIndex = dispatch.indexOf('"$BUTLER_BUN" run "$BUTLER_HOME/packages/butler-agent/scripts/run-worker.ts"');
  const eagerExecutingIndex = dispatch.indexOf(
    'write_worker_activity "executing" "Executing: worker implementation is running."',
  );

  expect(planningIndex).toBeGreaterThan(0);
  expect(runnerIndex).toBeGreaterThan(planningIndex);
  expect(eagerExecutingIndex).toBe(-1);
  expect(dispatch).toContain('if [[ "$(worker_activity_phase)" != "failed" ]]');
  expect(dispatch).toContain(". + {phase:$phase,status_line:$status_line,updated_at:$updated_at}");
});

test("worker runner writes account-model failures into activity before exiting", () => {
  const runner = readFileSync(join(root, "packages/butler-agent/scripts/run-worker.ts"), "utf8");

  expect(runner).toContain("workerFailureStatusLine");
  expect(runner).toContain("selected worker model is not available");
  expect(runner).toContain('writeActivity("failed", workerFailureStatusLine(message))');
});

test("planned public report completion terminates the review turn instead of spawning duplicate work", () => {
  const nativeLoop = readFileSync(join(root, "packages/butler-agent/src/agent/turn/native-tool-loop.ts"), "utf8");

  expect(nativeLoop).toContain("finalTextFromToolResult");
  expect(nativeLoop).toContain('name === "write_planned_public_report"');
  expect(nativeLoop).toContain("publicReportFromToolOutput");
  expect(nativeLoop).not.toContain("workerStartHeartbeat()");
  expect(nativeLoop).toContain("After `write_planned_public_report` succeeds");
});


test("worker shell semantic phase follows state-machine context, not command kind", () => {
  expect(summarizeWorkerShellActivity("rg -n \"worker\" src", { semanticPhase: "planning" })).toMatchObject({
    phase: "planning",
    semanticPhase: "planning",
    actionKind: "search",
  });
  expect(summarizeWorkerShellActivity("rg -n \"worker\" src", { semanticPhase: "verifying" })).toMatchObject({
    phase: "verifying",
    semanticPhase: "verifying",
    actionKind: "search",
  });
  expect(workerActivityUpdateForShellCommand("sed -n '1,80p' README.md", "call-readme-context", "ko", { semanticPhase: "planning" })).toMatchObject({
    phase: "planning",
    semanticPhase: "planning",
    actionKind: "read_file",
  });
});
