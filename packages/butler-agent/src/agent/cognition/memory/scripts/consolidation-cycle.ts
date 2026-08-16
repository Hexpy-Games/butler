// Consolidation Cycle orchestrator — scheduled cognition maintenance.
//
// Sequence:
//   1. Parse config; if cognition.consolidationCycle.enabled === false → exit 0.
//   2. Acquire consolidation lock (atomic O_EXCL). If held by another live
//      orchestrator → emit lock-held-by-other and exit 0.
//   3. Run catchup → consolidate → optimize → health inside a try/finally
//      that releases the lock. Each phase gets a soft sub-budget; the total
//      wall-clock budget is hard.
//   4. Emit structured events per phase and a daily summary line.
//   5. Record phase failures in the structured event log.
//
// Invoked by the scheduled Cognition wrapper after the generic Cognition Cycle.
import { createRequire } from "node:module";
import { join } from "path";
import { homedir } from "os";

import { Budget, BudgetExceeded } from "./lib/budget.ts";
import { EventLogger } from "./lib/events.ts";
import {
  acquireConsolidationLock,
  releaseConsolidationLock,
  inspectConsolidationLock,
  consolidationLockPath,
} from "./lib/lock.ts";
import { runConsolidate } from "./phases/consolidate.ts";
import { runOptimize } from "./phases/optimize.ts";
import { runHealth } from "./phases/health.ts";
import { findMainSessions } from "./lib/sessions.ts";
import { compactHotCacheFile } from "./lib/hot-cache-compaction.ts";
import { butlerAgentSourcePath } from "../../../../runtime/paths.ts";
import { cognitionConsolidationRoot, cognitionMemoryRoot } from "../../paths.ts";
import { refreshRegisteredProjectCapsules } from "../project-memory.ts";

const fs: typeof import("fs") = createRequire(import.meta.url)("fs");

export interface ConsolidationCycleConfig {
  enabled: boolean;
  totalBudgetMs: number;
  subPhaseBudgetsMs: {
    catchup: number;
    consolidate: number;
    optimize: number;
    health: number;
  };
  lockPath: string;
  logsDir: string;
  summaryPath: string;
}

export interface ConsolidationCyclePhaseDeps {
  runCatchup: () => Promise<Record<string, unknown>>;
  runConsolidate: () => Promise<Record<string, unknown>>;
  runOptimize: () => Promise<Record<string, unknown>>;
  runHealth: () => Promise<Record<string, unknown>>;
  runProjectCapsules?: () => Promise<Record<string, unknown>>;
}

export interface ConsolidationCycleResult {
  exitCode: number;
  skipped?: boolean;
  lockHeldByOther?: boolean;
  phasesRun: number;
  aborted?: "aborted_budget" | "error";
}

type PhaseName = "catchup" | "consolidate" | "optimize" | "health";

const PHASES: PhaseName[] = ["catchup", "consolidate", "optimize", "health"];

export async function runConsolidationCycle(
  cfg: ConsolidationCycleConfig,
  deps: ConsolidationCyclePhaseDeps,
): Promise<ConsolidationCycleResult> {
  if (!cfg.enabled) {
    console.log("consolidation-cycle disabled");
    return { exitCode: 0, skipped: true, phasesRun: 0 };
  }

  const logger = new EventLogger(cfg.logsDir, undefined, cfg.summaryPath);
  const failedPhases: Array<{ phase: string; error: string }> = [];
  let aborted: ConsolidationCycleResult["aborted"];

  if (!acquireConsolidationLock(cfg.lockPath)) {
    const info = inspectConsolidationLock(cfg.lockPath);
    logger.emit({
      phase: "lock",
      status: "warn",
      duration_ms: 0,
      metrics: { lock_held_by_other: true, other_pid: info?.pid ?? null },
    });
    return { exitCode: 0, lockHeldByOther: true, phasesRun: 0 };
  }

  const start = Date.now();
  const budget = new Budget(cfg.totalBudgetMs);
  let phasesRun = 0;

  try {
    for (const phase of PHASES) {
      if (budget.isHardBudgetExceeded()) {
        aborted = "aborted_budget";
        break;
      }
      budget.startSubPhase(phase, cfg.subPhaseBudgetsMs[phase]);
      const phaseStart = Date.now();
      try {
        const metrics = await runPhase(phase, deps, budget);
        logger.emit({
          phase,
          status: "ok",
          duration_ms: Date.now() - phaseStart,
          metrics,
        });
        phasesRun += 1;
      } catch (err: any) {
        if (err instanceof BudgetExceeded) {
          aborted = "aborted_budget";
          logger.emit({
            phase,
            status: "aborted_budget",
            duration_ms: Date.now() - phaseStart,
          });
          break;
        }
        const info = {
          name: err?.name ?? "Error",
          message: String(err?.message ?? err),
          stack_tail: String(err?.stack ?? "").slice(-500),
        };
        logger.emit({
          phase,
          status: "error",
          duration_ms: Date.now() - phaseStart,
          error: info,
        });
        failedPhases.push({ phase, error: info.message });
      } finally {
        budget.endSubPhase();
      }
    }
  } finally {
    releaseConsolidationLock(cfg.lockPath);
  }

  const duration_ms = Date.now() - start;
  const summaryStatus: "ok" | "error" | "aborted_budget" =
    aborted ?? (failedPhases.length > 0 ? "error" : "ok");
  logger.appendSummary({
    phase: "summary",
    status: summaryStatus,
    duration_ms,
    metrics: {
      phases_run: phasesRun,
      aborted: aborted === "aborted_budget",
      failed_phases: failedPhases.map((f) => f.phase),
    },
  });

  return { exitCode: 0, phasesRun, aborted };
}

async function runPhase(
  name: PhaseName,
  deps: ConsolidationCyclePhaseDeps,
  budget: Budget,
): Promise<Record<string, unknown>> {
  switch (name) {
    case "catchup":
      return runWithBudget(deps.runCatchup, budget);
    case "consolidate":
      return runWithBudget(deps.runConsolidate, budget);
    case "optimize":
      return runWithBudget(deps.runOptimize, budget);
    case "health":
      return runWithBudget(async () => {
        const projectCapsules = deps.runProjectCapsules ? await deps.runProjectCapsules() : {};
        const health = await deps.runHealth();
        return {
          ...health,
          ...projectCapsules,
        };
      }, budget);
  }
}

async function runWithBudget(
  fn: () => Promise<Record<string, unknown>>,
  budget: Budget,
): Promise<Record<string, unknown>> {
  // Run the phase and check the hard budget after it returns. Individual phases
  // poll budget.check() themselves at natural checkpoints; this is the final guard.
  const result = await fn();
  budget.check();
  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point — loads butler.config.json, wires real phase implementations,
// and runs the cycle.
// ---------------------------------------------------------------------------
function butlerHome(): string {
  return process.env.BUTLER_HOME ?? process.cwd();
}
function butlerData(): string {
  return process.env.BUTLER_DATA ?? join(homedir(), ".butler");
}

function loadConfig(): ConsolidationCycleConfig {
  const configPath = join(butlerData(), "butler.config.json");
  let raw: any = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {}
  const sc = raw?.cognition?.consolidationCycle ?? {};
  const consolidationDir = cognitionConsolidationRoot(butlerData());
  return {
    enabled: sc.enabled !== false,
    totalBudgetMs: sc.totalBudgetMs ?? 600_000,
    subPhaseBudgetsMs: {
      catchup: sc.subPhaseBudgetsMs?.catchup ?? 120_000,
      consolidate: sc.subPhaseBudgetsMs?.consolidate ?? 240_000,
      optimize: sc.subPhaseBudgetsMs?.optimize ?? 180_000,
      health: sc.subPhaseBudgetsMs?.health ?? 60_000,
    },
    lockPath: consolidationLockPath(butlerData()),
    logsDir: join(consolidationDir, "logs"),
    summaryPath: join(consolidationDir, "run-summary.jsonl"),
  };
}

function loadRawConsolidationCycle(): any {
  try {
    const raw = JSON.parse(
      fs.readFileSync(join(butlerData(), "butler.config.json"), "utf8"),
    );
    return raw?.cognition?.consolidationCycle ?? {};
  } catch {
    return {};
  }
}

function buildCatchupSessions(): Array<import("./phases/catchup.ts").CatchupSession> {
  try {
    return findMainSessions().map((s) => ({
      path: s.path,
      sessionId: s.sessionId,
      offsetKey: `butler:${s.sessionId}`,
    }));
  } catch {
    return [];
  }
}

function makeCatchupDrain(): (args: {
  sessionId: string;
  path: string;
  fromByte: number;
  toByte: number;
}) => { ok: boolean; linesProcessed: number } {
  const indexTs = butlerAgentSourcePath(butlerHome(), "agent", "cognition", "memory", "scripts", "index.ts");
  const saveHotTs = butlerAgentSourcePath(butlerHome(), "agent", "cognition", "memory", "scripts", "save_hot.ts");
  const { spawnSync } = require("child_process") as typeof import("child_process");
  const bunExec = process.execPath;
  return ({ sessionId, path }) => {
    // Best-effort: invoke save_hot (non-fatal) then index.ts against the full
    // transcript. The existing pipeline is idempotent for already-indexed
    // entries, so a byte-level delta replay is not required here.
    if (fs.existsSync(saveHotTs)) {
      try {
        spawnSync(
          bunExec,
          ["run", saveHotTs, "--session-id", sessionId, "--type", "conversation", "--project", "butler"],
          { encoding: "utf8", timeout: 60_000 },
        );
      } catch {}
    }
    if (!fs.existsSync(indexTs)) {
      return { ok: false, linesProcessed: 0 };
    }
    try {
      const r = spawnSync(
        bunExec,
        [
          "run",
          indexTs,
          "--file",
          path,
          "--project",
          "butler",
          "--session-id",
          sessionId,
          "--type",
          "conversation",
          "--source",
          "consolidation-cycle",
        ],
        { encoding: "utf8", timeout: 120_000 },
      );
      return { ok: r.status === 0, linesProcessed: 0 };
    } catch {
      return { ok: false, linesProcessed: 0 };
    }
  };
}

if (import.meta.main) {
  const cfg = loadConfig();
  if (!cfg.enabled) {
    const r = await runConsolidationCycle(cfg, {
      runCatchup: async () => ({}),
      runConsolidate: async () => ({}),
      runOptimize: async () => ({}),
      runHealth: async () => ({}),
    });
    process.exit(r.exitCode);
  }
  const sc = loadRawConsolidationCycle();
  const memoryDir = cognitionMemoryRoot(butlerData());
  const consolidationDir = cognitionConsolidationRoot(butlerData());
  const dbPath = join(memoryDir, "db", "graph.sqlite");
  const lancePath = join(memoryDir, "db", "butler.lance");
  const lanceTableName = "butler_memory";
  fs.mkdirSync(join(memoryDir, "db"), { recursive: true });
  fs.mkdirSync(consolidationDir, { recursive: true });

  const { Database } = await import("bun:sqlite");
  const lancedb = await import("@lancedb/lancedb");

  const db = new Database(dbPath);
  let lanceTable: any = null;
  try {
    const lanceConn = await lancedb.connect(lancePath);
    try {
      lanceTable = await lanceConn.openTable(lanceTableName);
    } catch {}
  } catch {}

  const decayD = sc.activationDecayD ?? 0.5;
  const edgeBoostWindowMs = 7 * 86400_000;
  const activationPruneFloor = sc.activationPruneFloor ?? -3.0;
  const hotCacheCompactThresholdBytes = sc.hotCacheCompactThresholdBytes ?? 32768;
  const logRetentionDays = sc.logRetentionDays ?? 7;
  const diskQuotaMb = sc.diskQuotaMb ?? 2048;

  const deps: ConsolidationCyclePhaseDeps = {
    runCatchup: async () => {
      const mod = await import("./phases/catchup.ts");
      return mod.runCatchup({
        offsetFile: join(memoryDir, "db", "session-sync-offset.json"),
        sessions: buildCatchupSessions(),
        drain: makeCatchupDrain(),
      }) as unknown as Record<string, unknown>;
    },
    runConsolidate: async () =>
      runConsolidate({ db, nowMs: Date.now(), decayD, edgeBoostWindowMs }) as unknown as Record<string, unknown>,
    runOptimize: async () => {
      if (!lanceTable) return { skipped: true, reason: "no-lance-table" };
      return (await runOptimize({
        db,
        table: lanceTable,
        hotCacheDir: join(memoryDir, "hot"),
        hotCacheCompactThresholdBytes,
        activationPruneFloor,
        compactHotCache: (filePath: string) => compactHotCacheFile(filePath),
      })) as unknown as Record<string, unknown>;
    },
    runProjectCapsules: async () => {
      const projectCapsules = refreshRegisteredProjectCapsules({
        butlerData: butlerData(),
        maxProjects: sc.projectCapsuleRefreshLimit ?? 20,
      });
      return {
        project_capsules_considered: projectCapsules.considered,
        project_capsules_refreshed: projectCapsules.refreshed,
        project_capsule_failures: projectCapsules.failed.length,
      };
    },
    runHealth: async () =>
      runHealth({
        db,
        memoryDir,
        logsDir: join(consolidationDir, "logs"),
        locksDir: join(consolidationDir, "locks"),
        logRetentionDays,
        diskQuotaMb,
        now: Date.now(),
        alert: () => {},
      }) as unknown as Record<string, unknown>,
  };

  let exitCode: number;
  try {
    const r = await runConsolidationCycle(cfg, deps);
    exitCode = r.exitCode;
  } catch {
    // Defense in depth — runConsolidationCycle catches phase exceptions, but if the
    // orchestrator itself throws we must still release DB handles.
    exitCode = 1;
  } finally {
    try { db.close(); } catch {}
  }
  process.exit(exitCode);
}
