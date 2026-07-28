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
    assertMatch(summarizeWorkerShellActivity("rg -n worker_activity packages") as unknown as Record<string, unknown>, {
      phase: "executing",
      semanticPhase: "inspecting",
      actionKind: "search",
    });

    assertMatch(summarizeWorkerShellActivity("sed -n '1,80p' packages/butler-agent/scripts/status-context.ts") as unknown as Record<string, unknown>, {
      phase: "executing",
      semanticPhase: "inspecting",
      actionKind: "read_file",
    });

    assertMatch(summarizeWorkerShellActivity("python3 - <<'PY'\nfrom pathlib import Path\nPath('x').write_text('ok')\nPY") as unknown as Record<string, unknown>, {
      phase: "executing",
      semanticPhase: "executing",
      actionKind: "edit_file",
    });

    assertMatch(summarizeWorkerShellActivity("bun test tests/unit/worker-activity-semantic-phase.test.ts") as unknown as Record<string, unknown>, {
      phase: "verifying",
      semanticPhase: "verifying",
      actionKind: "test",
    });

    assertMatch(summarizeWorkerShellActivity("git add a && git commit -m test") as unknown as Record<string, unknown>, {
      phase: "executing",
      semanticPhase: "committing",
      actionKind: "commit",
    });


    assertMatch(summarizeWorkerShellActivity("rg -n worker packages", { semanticPhase: "planning" }) as unknown as Record<string, unknown>, {
      phase: "planning",
      semanticPhase: "planning",
      actionKind: "search",
    });

    assertMatch(summarizeWorkerShellActivity("rg -n worker packages", { semanticPhase: "verifying" }) as unknown as Record<string, unknown>, {
      phase: "verifying",
      semanticPhase: "verifying",
      actionKind: "search",
    });

    const update = workerActivityUpdateForShellCommand("rg --files packages/butler-agent", "call_123", "ko", { semanticPhase: "planning" });

    assertMatch(update as unknown as Record<string, unknown>, {
      phase: "planning",
      semanticPhase: "planning",
      actionKind: "list_files",
    });
    assertEqual(update.workBlock?.rows[0]?.tool_call_id, "call_123", "tool_call_id");
    assertEqual(update.workBlock?.rows[0]?.safe_tool_name, "Command", "safe_tool_name");
}

run();
