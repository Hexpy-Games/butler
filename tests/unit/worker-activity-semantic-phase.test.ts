import {
  summarizeWorkerShellActivity,
  workerActivityUpdateForShellCommand,
} from "../../packages/butler-agent/src/integrations/providers/provider.ts";

function assertMatch(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(`${key}: expected ${value}, received ${String(actual[key])}`);
    }
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function run(): void {
    assertMatch(summarizeWorkerShellActivity("rg -n worker_activity packages"), {
      phase: "executing",
      semanticPhase: "inspecting",
      actionKind: "search",
    });

    assertMatch(summarizeWorkerShellActivity("sed -n '1,80p' packages/butler-agent/scripts/run-worker.ts"), {
      phase: "executing",
      semanticPhase: "inspecting",
      actionKind: "read_file",
    });

    assertMatch(summarizeWorkerShellActivity("python3 - <<'PY'\nfrom pathlib import Path\nPath('x').write_text('ok')\nPY"), {
      phase: "executing",
      semanticPhase: "executing",
      actionKind: "edit_file",
    });

    assertMatch(summarizeWorkerShellActivity("bun test tests/unit/worker-activity-semantic-phase.test.ts"), {
      phase: "verifying",
      semanticPhase: "verifying",
      actionKind: "test",
    });

    assertMatch(summarizeWorkerShellActivity("git add a && git commit -m test"), {
      phase: "executing",
      semanticPhase: "committing",
      actionKind: "commit",
    });

    const update = workerActivityUpdateForShellCommand("rg --files packages/butler-agent", "call_123", "ko");

    assertMatch(update, {
      phase: "executing",
      semanticPhase: "inspecting",
      actionKind: "list_files",
    });
    assertEqual(update.workBlock?.rows[0]?.tool_call_id, "call_123", "tool_call_id");
    assertEqual(update.workBlock?.rows[0]?.safe_tool_name, "Bash", "safe_tool_name");
}

run();
