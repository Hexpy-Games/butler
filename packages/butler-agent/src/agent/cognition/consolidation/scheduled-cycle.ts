import { spawnSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { butlerAgentSourcePath } from "../../../runtime/paths.ts";
import {
  runCognitionConsolidationCycle,
  type ConsolidationCycleResult,
} from "./cycle.ts";

export type LegacyMemoryCycleResult = {
  status: number | null;
  stderr?: string | null;
};

export type ScheduledCognitionConsolidationResult = {
  schema: "butler.cognition.scheduled-consolidation.v1";
  status: "completed" | "completed_with_errors";
  generic: {
    status: ConsolidationCycleResult["status"];
    phase_count: number;
    checkpoint_path: string;
    summary_path: string;
  };
  legacy_memory: {
    status: number | null;
    ok: boolean;
    stderr_chars: number;
  };
  raw_text_included: false;
};

export type RunScheduledCognitionConsolidationInput = {
  butlerHome?: string;
  butlerData?: string;
  runId?: string;
  runLegacyMemoryCycle?: () => LegacyMemoryCycleResult;
};

function butlerHome(input?: string): string {
  return input || process.env.BUTLER_HOME || process.cwd();
}

function butlerData(input?: string): string {
  return input || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function scheduledRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
  return `cr_scheduled_${stamp}`;
}

function defaultLegacyMemoryCycle(home: string, data: string): LegacyMemoryCycleResult {
  const bun = process.env.BUTLER_BUN || process.execPath;
  const result = spawnSync(
    bun,
    ["run", butlerAgentSourcePath(home, "agent", "cognition", "memory", "scripts", "consolidation-cycle.ts")],
    {
      cwd: data,
      encoding: "utf8",
      env: {
        ...process.env,
        BUTLER_HOME: home,
        BUTLER_DATA: data,
      },
    },
  );
  return {
    status: result.status,
    stderr: result.stderr,
  };
}

export async function runScheduledCognitionConsolidation(
  input: RunScheduledCognitionConsolidationInput = {},
): Promise<ScheduledCognitionConsolidationResult> {
  const home = butlerHome(input.butlerHome);
  const data = butlerData(input.butlerData);
  const generic = await runCognitionConsolidationCycle({
    butlerData: data,
    runId: input.runId ?? scheduledRunId(),
  });
  const legacy = input.runLegacyMemoryCycle
    ? input.runLegacyMemoryCycle()
    : defaultLegacyMemoryCycle(home, data);
  const legacyOk = legacy.status === 0;
  const genericOk = generic.status === "completed" || generic.status === "deferred_rate_limited" || generic.status === "lock_held";
  return {
    schema: "butler.cognition.scheduled-consolidation.v1",
    status: genericOk && legacyOk ? "completed" : "completed_with_errors",
    generic: {
      status: generic.status,
      phase_count: generic.phases.length,
      checkpoint_path: generic.checkpoint_path,
      summary_path: generic.summary_path,
    },
    legacy_memory: {
      status: legacy.status,
      ok: legacyOk,
      stderr_chars: legacy.stderr?.length ?? 0,
    },
    raw_text_included: false,
  };
}

if (import.meta.main) {
  const result = await runScheduledCognitionConsolidation();
  console.log(JSON.stringify(result));
  process.exit(result.status === "completed" ? 0 : 1);
}
