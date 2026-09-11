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
import { dirname, join } from "path";
import { homedir } from "os";

import { Budget, BudgetExceeded } from "./lib/budget.ts";
import { EventLogger } from "./lib/events.ts";
import {
  acquireConsolidationLockAsync,
  consolidationLockPath,
  releaseConsolidationLock,
} from "./lib/lock.ts";
import { runConsolidateWithMemoryGate } from "./phases/consolidate.ts";
import {
  cognitionConsolidationRoot,
} from "../../paths.ts";
import { refreshRegisteredProjectCapsules } from "../project-memory.ts";
import {
  activeMemoryDescriptorPath, initializeEmptyMemoryGenerationAsync, readActiveDescriptor,
  resolveMemoryGeneration, prepareMemoryRebuild, inspectMemoryGeneration,
  computeMemoryGenerationReadiness, prepareMemoryGenerationValidation, validateMemoryGeneration, activateMemoryGeneration,
  prepareMemoryGenerationActivation, rollbackMemoryGeneration, writeMemoryGenerationManifest, refreshMemoryRebuildSnapshot,
  readMemoryGenerationManifest, openMemoryGenerationCandidateWitness,
  prepareMemoryGenerationQualificationReuse, resumeRetiredMemoryGenerationForBuild,
  type MemoryGenerationReadiness,
  type PreparedMemoryGenerationValidation, type PreparedMemoryGenerationActivation,
  type MemoryGenerationCandidateWitness, type PreparedMemoryGenerationQualificationReuse,
} from "../projection/generation.ts";
import { canonicalConversationProjectionInventory, memorySourceInventoryHash, projectionHash, splitUtf8Spans } from "../projection/source.ts";
import { runRebuildGenerationCatchup, runServingGenerationCatchup } from "./phases/catchup.ts";
import { AgentConversationStore } from "../../../conversation/store.ts";
import { classifyConversationOrigin } from "../../../conversation/session-admission.ts";
import { readPersistedConversationAdmissionEvidence } from "../../../adapters/btcc/sqlite/turn-admission-repository.ts";
import { agentBtccStoragePaths } from "../../../adapters/btcc/sqlite/storage-ownership/index.ts";
import { readHistoricalAppOriginEvidence } from "../../../conversation/historical-recovery-runtime.ts";
import { NativeInboundQueue, type PersistedOriginEvidence } from "../../../../gateways/core/inbound-queue.ts";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { reprocessMemoryProjectionWindowAsync, repairMemoryCandidateInputs } from "../projection/ingestion.ts";
import { ensureV2MemorySchema, openProjectionDb, type ClaimedVectorUnit } from "../projection/store.ts";
import { completedVectorReceiptLacksExpectedIdentity } from "../recall/vector.ts";
import { executeMemoryIdentityCommand, type IdentityCommand } from "../projection/identity.ts";
import { readMemoryHealth } from "../quality.ts";
import { listTypedMemoryLifecycleSnapshot, listTypedMemoryRecordsSnapshot } from "../quality.ts";
import { TaskStore } from "../../../work/task-store.ts";
import type { MemoryExecutionContext } from "../projection/contracts.ts";

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
  assertWriteAuthority: () => void;
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
    return { exitCode: 0, skipped: true, phasesRun: 0 };
  }

  const logger = new EventLogger(cfg.logsDir, undefined, cfg.summaryPath);
  const failedPhases: Array<{ phase: string; error: string }> = [];
  let aborted: ConsolidationCycleResult["aborted"];

  const start = Date.now();
  const budget = new Budget(cfg.totalBudgetMs);
  let phasesRun = 0;

  for (const phase of PHASES) {
      if (budget.isHardBudgetExceeded()) {
        aborted = "aborted_budget";
        break;
      }
      budget.startSubPhase(phase, cfg.subPhaseBudgetsMs[phase]);
      const phaseStart = Date.now();
      try {
        if (phase !== "catchup") deps.assertWriteAuthority();
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
        const projectCapsules = deps.runProjectCapsules
          ? await deps.runProjectCapsules()
          : {};
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
function butlerData(): string {
  return process.env.BUTLER_DATA ?? join(homedir(), ".butler");
}

function loadConfig(data = butlerData()): ConsolidationCycleConfig {
  const configPath = join(data, "butler.config.json");
  let raw: any = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {}
  const sc = raw?.cognition?.consolidationCycle ?? {};
  const consolidationDir = cognitionConsolidationRoot(data);
  return {
    enabled: sc.enabled !== false,
    totalBudgetMs: sc.totalBudgetMs ?? 600_000,
    subPhaseBudgetsMs: {
      catchup: sc.subPhaseBudgetsMs?.catchup ?? 120_000,
      consolidate: sc.subPhaseBudgetsMs?.consolidate ?? 240_000,
      optimize: sc.subPhaseBudgetsMs?.optimize ?? 180_000,
      health: sc.subPhaseBudgetsMs?.health ?? 60_000,
    },
    lockPath: consolidationLockPath(data),
    logsDir: join(consolidationDir, "logs"),
    summaryPath: join(consolidationDir, "run-summary.jsonl"),
  };
}

function loadRawConsolidationCycle(data = butlerData()): any {
  try {
    const raw = JSON.parse(
      fs.readFileSync(join(data, "butler.config.json"), "utf8"),
    );
    return raw?.cognition?.consolidationCycle ?? {};
  } catch {
    return {};
  }
}

if (import.meta.main) {
  if (process.argv.includes("--memory-reprocess-window")) {
    try {
      const index = process.argv.indexOf("--input");
      const path = index >= 0 ? process.argv[index + 1] : undefined;
      if (!path) throw new Error("memory_reprocess_invalid_request");
      const request = JSON.parse(fs.readFileSync(path, "utf8"));
      const result = await reprocessMemoryProjectionWindowAsync({
        context: { butlerData: butlerData(), target: { kind: "active", expected_generation: request?.expected_generation }, signal: new AbortController().signal },
        request,
      });
      console.log(JSON.stringify(result));
      process.exit(0);
    } catch (error) {
      const code = error instanceof Error && /^memory_[a-z0-9_]+$/u.test(error.message) ? error.message : "memory_reprocess_failed";
      console.error(JSON.stringify({ ok: false, code }));
      process.exit(1);
    }
  }
  const identityIndex = process.argv.indexOf("--memory-identity");
  if (identityIndex >= 0) {
    const operation = process.argv[identityIndex + 1];
    const inputIndex = process.argv.indexOf("--input");
    const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
    if (!inputPath || !["inspect", "apply", "revoke"].includes(operation ?? "")) {
      console.error(JSON.stringify({ ok: false, code: "memory_identity_invalid_command" }));
      process.exit(1);
    }
    try {
      const command = JSON.parse(fs.readFileSync(inputPath, "utf8")) as IdentityCommand;
      if (command.operation !== operation) throw new Error("memory_identity_invalid_command");
      const result = await executeMemoryIdentityCommand({
        context: { butlerData: butlerData(), target: { kind: "active", expected_generation: command.expected_generation }, signal: new AbortController().signal },
        command,
      });
      console.log(JSON.stringify(result));
      process.exit(0);
    } catch (error) {
      const code = error instanceof Error && /^[a-z0-9_]+$/u.test(error.message) ? error.message : "memory_identity_failed";
      console.error(JSON.stringify({ ok: false, code }));
      process.exit(1);
    }
  }
  if (
    process.argv.includes("--memory-rebuild") &&
    process.argv.includes("initialize-empty")
  ) {
    try {
      console.log(
        JSON.stringify({
          ok: true,
          descriptor: await initializeEmptyMemoryGenerationAsync(butlerData()),
        }),
      );
      process.exit(0);
    } catch (error) {
      const code =
        error instanceof Error ? error.message : "memory_initialization_failed";
      console.error(JSON.stringify({ ok: false, code }));
      process.exit(1);
    }
  }
  if (process.argv.includes("--memory-rebuild")) {
    try {
      const result = await runMemoryRebuildCommand({
        butlerData: butlerData(),
        argv: process.argv.slice(2),
        signal: new AbortController().signal,
      });
      console.log(JSON.stringify({ ok: true, ...result }));
      process.exit(0);
    } catch (error) {
      const code = error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)
        ? error.message
        : "memory_rebuild_failed";
      console.error(JSON.stringify({ ok: false, code }));
      process.exit(1);
    }
  }
  try {
    const result = await runConfiguredMemoryConsolidation({ butlerData: butlerData() });
    console.log(JSON.stringify(result));
    process.exit(result.exitCode);
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)
      ? error.message
      : "memory_consolidation_failed";
    console.error(JSON.stringify({ ok: false, code }));
    process.exit(1);
  }
}

function option(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : null;
}

type VectorRepairRequest = {
  generation_id: string;
  units: Array<{
    unit_id: string;
    owner_revision: string;
    source_revision: string;
    receipt_json: string;
  }>;
};

function readVectorRepairRequest(path: string): VectorRepairRequest {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(path, "utf8")); }
  catch { throw new Error("memory_vector_repair_invalid_request"); }
  const request = value as Partial<VectorRepairRequest> | null;
  if (!request || typeof request.generation_id !== "string" || !request.generation_id ||
    !Array.isArray(request.units) || request.units.length === 0 ||
    request.units.some((unit) => !unit || typeof unit.unit_id !== "string" || !unit.unit_id ||
      typeof unit.owner_revision !== "string" || !unit.owner_revision ||
      typeof unit.source_revision !== "string" || !unit.source_revision ||
      typeof unit.receipt_json !== "string" || !unit.receipt_json) ||
    new Set(request.units.map((unit) => unit.unit_id)).size !== request.units.length)
    throw new Error("memory_vector_repair_invalid_request");
  return request as VectorRepairRequest;
}

function resetSelectedInvalidVectors(input: {
  context: MemoryExecutionContext;
  db: ReturnType<typeof openProjectionDb>;
  request: VectorRepairRequest;
}): number {
  const generation = resolveMemoryGeneration(input.context);
  const manifest = readMemoryGenerationManifest(input.context.butlerData, generation.generationId);
  if (input.request.generation_id !== generation.generationId || !manifest.embedding)
    throw new Error("memory_vector_repair_preimage_changed");
  const units: Array<ClaimedVectorUnit & { state: string; source_membership_invalid: number }> = [];
  for (const requested of input.request.units) {
    const unit = input.db.query<ClaimedVectorUnit & { state: string; source_membership_invalid: number }, [string]>(`
      SELECT u.*,j.revision source_revision,c.conversation_session_id,
        (SELECT ordered.source_kind FROM memory_chunk_sources ordered
          WHERE ordered.episode_id=c.memory_chunk_id AND ordered.revision=c.current_revision
          ORDER BY ordered.source_id LIMIT 1) source_kind,
        (SELECT ordered.observed_at FROM memory_chunk_sources ordered
          WHERE ordered.episode_id=c.memory_chunk_id AND ordered.revision=c.current_revision
            AND ordered.source_id IN (SELECT value FROM json_each(u.source_ids_json))
            AND (u.record_kind='episode' OR (ordered.origin_kind=u.origin_kind AND EXISTS(
              SELECT 1 FROM entity_mentions own WHERE own.source_id=ordered.source_id AND own.entity_id=u.owner_id)))
          ORDER BY julianday(ordered.observed_at) DESC,ordered.source_id DESC LIMIT 1) source_observed_at,
        CASE WHEN NOT (u.project_id IS c.project_id)
          OR u.source_ids_json IS NULL OR json_array_length(u.source_ids_json)=0
          OR EXISTS(SELECT 1 FROM json_each(u.source_ids_json) refs WHERE NOT EXISTS(
            SELECT 1 FROM memory_chunk_sources current_source
            WHERE current_source.source_id=refs.value
              AND current_source.episode_id=c.memory_chunk_id
              AND current_source.revision=c.current_revision
              AND (u.record_kind='episode' OR (current_source.origin_kind=u.origin_kind AND EXISTS(
                SELECT 1 FROM entity_mentions current_mention
                WHERE current_mention.entity_id=u.owner_id AND current_mention.source_id=current_source.source_id
                  AND current_mention.episode_id=c.memory_chunk_id AND current_mention.revision=c.current_revision)))
          )) THEN 1 ELSE 0 END source_membership_invalid
      FROM memory_vector_units u
      JOIN memory_projection_jobs j ON j.job_id=u.job_id
      JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
      WHERE u.unit_id=?`).get(requested.unit_id);
    if (!unit || unit.state !== "complete" || unit.owner_revision !== requested.owner_revision ||
      unit.source_revision !== requested.source_revision || unit.receipt_json !== requested.receipt_json ||
      unit.source_membership_invalid !== 0 || !unit.source_kind || !unit.source_observed_at)
      throw new Error("memory_vector_repair_preimage_changed");
    units.push(unit);
  }
  if (units.some((unit) => !completedVectorReceiptLacksExpectedIdentity(
    unit, generation.generationId, manifest.embedding!.version,
  )))
    throw new Error("memory_vector_repair_preimage_changed");
  return input.db.transaction(() => {
    for (const [index, unit] of units.entries()) {
      const requested = input.request.units[index]!;
      const changed = input.db.query(`UPDATE memory_vector_units SET state='pending',error_code=NULL,
        next_attempt_at=NULL,owner_pid=NULL,owner_nonce=NULL,started_at=NULL,receipt_json=NULL,
        provider_invoked=0,outcome_known=1,invocation_ref=NULL
        WHERE unit_id=? AND state='complete' AND owner_revision=? AND receipt_json=?
          AND EXISTS(SELECT 1 FROM memory_projection_jobs current_job
            JOIN memory_chunks current_chunk ON current_chunk.memory_chunk_id=current_job.episode_id
              AND current_chunk.current_revision=current_job.revision
            WHERE current_job.job_id=memory_vector_units.job_id AND current_job.revision=?)`)
        .run(unit.unit_id, requested.owner_revision, requested.receipt_json, requested.source_revision).changes;
      if (changed !== 1) throw new Error("memory_vector_repair_preimage_changed");
    }
    for (const unit of units) {
      const column = unit.record_kind === "node" ? "node_vectors_state" : "episode_vectors_state";
      input.db.query(`UPDATE memory_projection_jobs SET ${column}=? WHERE job_id=?`)
        .run(JSON.stringify({ state: "pending", blocked_by: "memory_vector_repair_requested" }), unit.job_id);
    }
    return units.length;
  })();
}

export async function runMemoryRebuildCommand(input: {
  butlerData: string; argv: string[]; signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  const marker = input.argv.indexOf("--memory-rebuild");
  const operation = marker >= 0 ? input.argv[marker + 1] : null;
  const generationId = option(input.argv, "--generation");
  const vectorRepairPath = option(input.argv, "--vector-repair-input");
  if (input.argv.includes("--vector-repair-input") && (!vectorRepairPath || operation !== "retry-failed"))
    throw new Error("memory_rebuild_invalid_request");
  if (operation === "prepare") {
    const prepared = readLiveMemorySourceInventory(input.butlerData, { signal: input.signal });
    return { operation, ...prepareMemoryRebuild({ butlerData: input.butlerData, ...prepared,
      verifySnapshotInventory: (sourceRoot) => readSnapshotMemorySourceInventory(sourceRoot, prepared.sourceInventory) }) };
  }
  if (!generationId) throw new Error("memory_rebuild_invalid_request");
  let manifest = inspectMemoryGeneration({ butlerData: input.butlerData, generationId }).manifest;
  const buildWallMs = 10 * 60_000;
  // The extractor owner has a 180 second local timeout. Keep another 30 seconds
  // for settlement and 60 seconds for finalization in this serial pass. Those are
  // operational margins, not hard I/O bounds: each background lease acquisition
  // can wait up to 30 seconds, and final source reads consume the supplied command
  // deadline rather than owning an independent 60 second timer.
  const semanticQuantumMaxMs = 180_000;
  const quantumSettlementGraceMs = 30_000;
  const finalizationReserveMs = 60_000;
  const deadlineAt = Date.now() + buildWallMs;
  const projectionDeadlineAt = deadlineAt - finalizationReserveMs;
  const quantumAdmissionDeadlineAt = projectionDeadlineAt -
    semanticQuantumMaxMs - quantumSettlementGraceMs;
  let context: MemoryExecutionContext = {
    butlerData: input.butlerData,
    target: { kind: "rebuild" as const, generation_id: generationId, canonical_snapshot_id: manifest.canonical_snapshot_id },
    signal: input.signal,
    deadlineAt,
    waitClass: "background" as const,
  };
  if (operation === "inspect") return { operation, result: inspectMemoryGeneration({ butlerData: input.butlerData, generationId }) };
  if (operation === "repair-inputs") {
    const requestPath = option(input.argv, "--input");
    if (!requestPath || fs.statSync(requestPath).size > 32 * 1024)
      throw new Error("memory_input_repair_invalid_request");
    if (readActiveDescriptor(input.butlerData).generation_id === generationId) {
      context = { ...context, target: { kind: "active", expected_generation: generationId } };
    } else if (manifest.state !== "building") {
      throw new Error("memory_generation_changed");
    }
    const result = await repairMemoryCandidateInputs({ context, request: JSON.parse(fs.readFileSync(requestPath, "utf8")), dryRun: input.argv.includes("--dry-run") });
    return { operation, generationId, ...result };
  }
  if (operation === "build") {
    const currentInventory = readLiveMemorySourceInventory(input.butlerData, { signal: input.signal, deadlineAt });
    if (currentInventory.sourceInventoryHash !== manifest.source_inventory_hash) {
      const next = refreshMemoryRebuildSnapshot({ butlerData: input.butlerData, generationId,
        expectedSnapshotId: manifest.canonical_snapshot_id, ...currentInventory,
        verifySnapshotInventory: (sourceRoot) => readSnapshotMemorySourceInventory(sourceRoot, currentInventory.sourceInventory) });
      manifest = readMemoryGenerationManifest(input.butlerData, generationId);
      context = { ...context, target: { kind: "rebuild" as const, generation_id: generationId,
        canonical_snapshot_id: next.canonicalSnapshotId } };
    }
    const catchup = await runRebuildGenerationCatchup({ butlerData: input.butlerData, generationId,
      canonicalSnapshotId: manifest.canonical_snapshot_id, limit: 256, signal: input.signal,
      deadlineAt: projectionDeadlineAt });
    const projectionContext = { ...context, deadlineAt: projectionDeadlineAt };
    const snapshotRoot = resolveMemoryGeneration(context).sourceRoot;
    const typed = listTypedMemoryRecordsSnapshot(snapshotRoot);
    for (const { record } of typed) {
      await import("../projection/ingestion.ts").then((module) => module.ingestConversationMemory({
        context: projectionContext,
        source: record.source_kind === "task_report"
          ? { kind: "task_report" as const, record_id: record.record_id, revision: record.revision, operation_id: record.operation_id }
          : { kind: "explicit_record" as const, record_kind: record.record_kind as "rule" | "feedback", record_id: record.record_id, revision: record.revision, operation_id: record.operation_id },
      }));
    }
    const quanta = { semantic_windows: 0, vector_units: 0, cache_jobs: 0, other: 0 };
    let operations = 0;
    let lastProgress: Record<string, unknown> | null = null;
    let admissionClosed = false;
    while (quanta.semantic_windows < 100 && operations < 400 && !input.signal.aborted) {
      if (Date.now() >= quantumAdmissionDeadlineAt) { admissionClosed = true; break; }
      const before = readRebuildQuantumCounters(projectionContext);
      const progress = await import("../projection/ingestion.ts").then((module) =>
        module.advanceNextMemoryProjection({ context: projectionContext }));
      if (!progress) break;
      lastProgress = progress as unknown as Record<string, unknown>;
      const after = readRebuildQuantumCounters(projectionContext);
      quanta.semantic_windows += Math.max(0,
        after.semanticAttempts - before.semanticAttempts,
        after.semanticSettled - before.semanticSettled);
      quanta.vector_units += Math.max(0, after.vector - before.vector);
      quanta.cache_jobs += Math.max(0, after.cache - before.cache);
      if (after.semanticAttempts === before.semanticAttempts && after.semanticSettled === before.semanticSettled &&
        after.vector === before.vector && after.cache === before.cache) quanta.other += 1;
      operations += 1;
    }
    const stableLive = prepareStableLiveMemorySource({ butlerData: input.butlerData, signal: input.signal,
      deadlineAt, classifyOrigins: false });
    if (stableLive.sourceInventoryHash !== manifest.source_inventory_hash) {
      stableLive.witness.close();
      throw new Error("memory_inventory_changed");
    }
    const sourceInventory = JSON.parse(fs.readFileSync(join(resolveMemoryGeneration(context).sourceRoot, "memory-source-inventory.json"), "utf8"));
    const count = Array.isArray(sourceInventory.entries)
      ? sourceInventory.entries.reduce((sum: number, entry: any) => sum + Number(entry.sourceUnitCount ?? 0), 0) +
        (Array.isArray(sourceInventory.typed) ? sourceInventory.typed.reduce((sum: number, entry: any) =>
          sum + (Array.isArray(entry.source_ids) ? entry.source_ids.length : 0), 0) : 0)
      : 0;
    let candidateWitness: MemoryGenerationCandidateWitness;
    try { candidateWitness = await openMemoryGenerationCandidateWitness(input.butlerData, generationId); }
    catch (error) { stableLive.witness.close(); throw error; }
    let readiness: MemoryGenerationReadiness;
    try {
      readiness = await computeMemoryGenerationReadiness({ butlerData: input.butlerData, generationId,
        inventoryHash: manifest.source_inventory_hash, inventorySourceCount: count });
      await candidateWitness.assertCurrent();
      await import("../projection/ingestion.ts").then((module) => module.withMemoryWriteGateAsync(context, async () => {
        const current = readMemoryGenerationManifest(input.butlerData, generationId);
        stableLive.witness.assertCurrent();
        await candidateWitness.assertCurrent();
        if (current.state !== "building" || current.canonical_snapshot_id !== manifest.canonical_snapshot_id ||
          current.source_inventory_hash !== manifest.source_inventory_hash)
          throw new Error("memory_generation_changed");
        const candidateChanged = current.readiness?.sha256 !== readiness.sha256 ||
          current.acceptance_binding?.target_evidence_sha256 !== readiness.evidence_sha256;
        writeMemoryGenerationManifest(input.butlerData, generationId, (latest) => ({
          ...latest, readiness, registered_source_count: readiness.registered,
          unaccounted_source_count: readiness.unaccounted,
          required_acceptance_passed: candidateChanged ? false : latest.required_acceptance_passed,
          acceptance_binding: latest.acceptance_binding,
          state: "building",
        }));
      }));
    } finally { candidateWitness.close(); stableLive.witness.close(); }
    return { operation, catchup, quanta, operations, last_progress: lastProgress,
      deadline_reached: admissionClosed || Date.now() >= deadlineAt, pending: {
        semantic: readiness.semantic.pending, vectors: readiness.vectors.pending, cache: readiness.cache.pending,
      }, readiness };
  }
  if (operation === "retry-failed") {
    const active = readActiveDescriptor(input.butlerData);
    if (active.generation_id === generationId) {
      context = { ...context, target: { kind: "active" as const, expected_generation: generationId } };
    } else if (manifest.state !== "building") {
      throw new Error("memory_generation_changed");
    }
    const db = openProjectionDb(resolveMemoryGeneration(context).graphPath);
    let retried = { semantic_windows: 0, vector_units: 0, cache_jobs: 0 };
    try {
      if (vectorRepairPath) {
        const request = readVectorRepairRequest(vectorRepairPath);
        const vectorUnits = await import("../projection/ingestion.ts").then((module) =>
          module.withMemoryWriteGateAsync(context, async () => {
            ensureV2MemorySchema(db);
            return resetSelectedInvalidVectors({ context, db, request });
          }));
        return { operation, generationId, retried: { ...retried, vector_units: vectorUnits } };
      }
      retried = await import("../projection/ingestion.ts").then((module) => module.withMemoryWriteGateAsync(context, () => {
        ensureV2MemorySchema(db);
        const recovery = createHash("sha256").update(JSON.stringify(["memory-retry-failed", generationId, new Date().toISOString()])).digest("hex");
        const semantic = db.query(`UPDATE memory_projection_windows SET
          state=CASE WHEN normalized_plan_json IS NOT NULL THEN 'planned' ELSE 'pending' END,error_code=NULL,next_attempt_at=NULL,
          owner_pid=NULL,owner_nonce=NULL,started_at=NULL,recovery_revision=?,recovery_base_attempt_count=attempt_count
          WHERE state='failed'`).run(recovery).changes;
        const vectors = db.query(`UPDATE memory_vector_units SET state='pending',error_code=NULL,next_attempt_at=NULL,
          owner_pid=NULL,owner_nonce=NULL,started_at=NULL
          WHERE state='failed' AND receipt_json IS NULL AND outcome_known=1`).run().changes;
        const cache = db.query(`UPDATE memory_projection_jobs SET hot_cache_state=?,hot_cache_next_attempt_at=NULL,
          hot_cache_owner_pid=NULL,hot_cache_owner_nonce=NULL,hot_cache_started_at=NULL
          WHERE json_extract(hot_cache_state,'$.state')='failed'`)
          .run(JSON.stringify({ state: "pending", blocked_by: "memory_retry_requested" })).changes;
        return { semantic_windows: semantic, vector_units: vectors, cache_jobs: cache };
      }));
    } finally { db.close(); }
    return { operation, generationId, retried };
  }
  if (operation === "validate") {
    const acceptancePath = option(input.argv, "--acceptance");
    if (!acceptancePath) throw new Error("memory_rebuild_invalid_request");
    const sourceInventory = JSON.parse(fs.readFileSync(join(resolveMemoryGeneration(context).sourceRoot, "memory-source-inventory.json"), "utf8"));
    const count = sourceInventory.entries.reduce((sum: number, entry: any) => sum + Number(entry.sourceUnitCount ?? 0), 0) +
      (Array.isArray(sourceInventory.typed) ? sourceInventory.typed.reduce((sum: number, entry: any) =>
        sum + (Array.isArray(entry.source_ids) ? entry.source_ids.length : 0), 0) : 0);
    const validationInput = { butlerData: input.butlerData, generationId,
      acceptancePath, verificationRoot: dirname(acceptancePath),
      inventoryHash: manifest.source_inventory_hash, inventorySourceCount: count };
    const live = prepareStableLiveMemorySource({ butlerData: input.butlerData, signal: input.signal,
      deadlineAt, classifyOrigins: true });
    if (live.sourceInventoryHash !== validationInput.inventoryHash ||
      sourceInventoryCount(live.sourceInventory) !== validationInput.inventorySourceCount) {
      live.witness.close();
      throw new Error("memory_inventory_changed");
    }
    let preparedValidation: PreparedMemoryGenerationValidation;
    try { preparedValidation = await prepareMemoryGenerationValidation(validationInput); }
    catch (error) { live.witness.close(); throw error; }
    const lockPath = consolidationLockPath(input.butlerData);
    const lease = await acquireConsolidationLockAsync(lockPath, {
      purpose: "rebuild_validate", waitClass: "background", signal: input.signal, deadlineAt,
    });
    if (!lease) { preparedValidation.candidateWitness.close(); live.witness.close(); throw new Error("memory_write_busy"); }
    let committed = false;
    try {
      const validated = await validateMemoryGeneration({ ...validationInput,
        assertCurrentInventory: live.witness.assertCurrent,
      }, preparedValidation, lease);
      committed = true;
      return { operation, manifest: validated };
    } finally {
      releaseConsolidationLock(lockPath, lease, committed);
      preparedValidation.candidateWitness.close();
      live.witness.close();
    }
  }
  if (operation === "activate") {
    const expected = option(input.argv, "--expected-active") ?? readActiveDescriptor(input.butlerData).generation_id;
    const ready = manifest.readiness;
    if (!ready) throw new Error("activation_requires_catchup");
    const live = prepareStableLiveMemorySource({ butlerData: input.butlerData, signal: input.signal,
      deadlineAt, classifyOrigins: true });
    if (live.sourceInventoryHash !== manifest.source_inventory_hash) {
      live.witness.close();
      throw new Error("activation_requires_catchup");
    }
    let preparedActivation: PreparedMemoryGenerationActivation;
    try { preparedActivation = await prepareMemoryGenerationActivation({
      butlerData: input.butlerData,
      generationId,
      expectedInventoryHash: manifest.source_inventory_hash,
      inventorySourceCount: sourceInventoryCount(live.sourceInventory),
    }); } catch (error) { live.witness.close(); throw error; }
    const lockPath = consolidationLockPath(input.butlerData);
    const lease = await acquireConsolidationLockAsync(lockPath, {
      purpose: "cutover", waitClass: "background", signal: input.signal, deadlineAt,
    });
    if (!lease) { preparedActivation.candidateWitness.close(); live.witness.close(); throw new Error("memory_write_busy"); }
    let committed = false;
    let descriptor;
    try {
      descriptor = await activateMemoryGeneration({ butlerData: input.butlerData, generationId, expectedActiveGeneration: expected,
        expectedInventoryHash: manifest.source_inventory_hash, expectedReadinessHash: ready.sha256,
        assertCurrentInventory: live.witness.assertCurrent,
      }, preparedActivation, lease);
      committed = true;
    } finally {
      releaseConsolidationLock(lockPath, lease, committed);
      preparedActivation.candidateWitness.close();
      live.witness.close();
    }
    return { operation, descriptor };
  }
  if (operation === "rollback") {
    const active = readActiveDescriptor(input.butlerData);
    if (active.generation_id !== generationId || !active.previous_generation_id) throw new Error("memory_rollback_unavailable");
    let previous = readMemoryGenerationManifest(input.butlerData, active.previous_generation_id);
    const bootstrap = previous.format === "v2" && previous.initialization_origin === "empty" &&
      !previous.required_acceptance_passed && !previous.acceptance_binding;
    let build: Record<string, unknown> | null = null;
    if (previous.format === "v2" && !bootstrap) {
      const initialLive = readLiveMemorySourceInventory(input.butlerData, { signal: input.signal, deadlineAt });
      const readiness = previous.readiness;
      const needsBuild = initialLive.sourceInventoryHash !== previous.source_inventory_hash || !readiness ||
        readiness.unaccounted > 0 || readiness.semantic.pending > 0 || readiness.semantic.failed > 0 ||
        readiness.vectors.pending > 0 || readiness.vectors.failed > 0 ||
        readiness.cache.pending > 0 || readiness.cache.failed > 0;
      if (needsBuild) {
        if (previous.state === "retired") {
          const preparePath = consolidationLockPath(input.butlerData);
          const prepareLease = await acquireConsolidationLockAsync(preparePath, {
            purpose: "rebuild_prepare", waitClass: "background", signal: input.signal, deadlineAt,
          });
          if (!prepareLease) throw new Error("memory_write_busy");
          let prepared = false;
          try {
            resumeRetiredMemoryGenerationForBuild({ butlerData: input.butlerData,
              generationId: previous.generation_id, expectedActiveGeneration: generationId }, prepareLease);
            prepared = true;
          } finally { releaseConsolidationLock(preparePath, prepareLease, prepared); }
        } else if (previous.state !== "building") throw new Error("memory_generation_changed");
        build = await runMemoryRebuildCommand({ butlerData: input.butlerData,
          argv: ["--memory-rebuild", "build", "--generation", previous.generation_id], signal: input.signal });
        previous = readMemoryGenerationManifest(input.butlerData, previous.generation_id);
      }
      if (!previous.acceptance_binding) return {
        operation, rollback_pending: true, target_generation_id: previous.generation_id,
        next_step: "validate", readiness: previous.readiness, build,
      };
    }
    const live = prepareStableLiveMemorySource({ butlerData: input.butlerData, signal: input.signal,
      deadlineAt, classifyOrigins: false });
    let preparedQualification: PreparedMemoryGenerationQualificationReuse | null = null;
    let candidateWitness: MemoryGenerationCandidateWitness | null = null;
    try {
      if (previous.format === "v2") {
        if (previous.acceptance_binding) {
          preparedQualification = await prepareMemoryGenerationQualificationReuse({
            butlerData: input.butlerData, generationId: previous.generation_id,
          });
          candidateWitness = preparedQualification.candidateWitness;
        } else candidateWitness = await openMemoryGenerationCandidateWitness(input.butlerData, previous.generation_id);
      }
    const lockPath = consolidationLockPath(input.butlerData);
    const lease = await acquireConsolidationLockAsync(lockPath, {
      purpose: "cutover", waitClass: "background", signal: input.signal,
      deadlineAt,
    });
    if (!lease) throw new Error("memory_write_busy");
    let committed = false;
    let descriptor;
    try {
      descriptor = await rollbackMemoryGeneration({ butlerData: input.butlerData, expectedActiveGeneration: generationId,
        sourceInventoryHash: live.sourceInventoryHash,
        sourceCount: sourceInventoryCount(live.sourceInventory),
        assertCurrentInventory: live.witness.assertCurrent,
      }, preparedQualification, candidateWitness, lease);
      committed = true;
    } finally { releaseConsolidationLock(lockPath, lease, committed); }
    const catchup = bootstrap
      ? await runServingGenerationCatchup({ butlerData: input.butlerData, limit: 256, signal: input.signal })
      : null;
    const currentTarget = inspectMemoryGeneration({ butlerData: input.butlerData, generationId: previous.generation_id });
    const projectionPending = currentTarget.degraded || !currentTarget.windows || !currentTarget.vectors || !currentTarget.cache ||
      currentTarget.windows.pending > 0 || currentTarget.windows.failed > 0 ||
      currentTarget.vectors.pending > 0 || currentTarget.vectors.failed > 0 ||
      currentTarget.cache.pending > 0 || currentTarget.cache.failed > 0;
    const catchupPending = Boolean(catchup && (!catchup.available || catchup.scanned >= 256));
    return { operation, descriptor, catchup,
      rollback_pending: previous.format === "v2" && (projectionPending || catchupPending),
      target_status: { available: !currentTarget.degraded, reason: currentTarget.reason, jobs: currentTarget.jobs,
        windows: currentTarget.windows, vectors: currentTarget.vectors, cache: currentTarget.cache },
      readiness: bootstrap ? null : previous.readiness, build };
    } finally {
      candidateWitness?.close();
      live.witness.close();
    }
  }
  throw new Error("memory_rebuild_invalid_request");
}

function typedSourceInventory(butlerData: string) {
  return listTypedMemoryRecordsSnapshot(butlerData).map(({ record, lifecycle }) => ({
    source_kind: record.source_kind, record_kind: record.record_kind,
    record_id: record.record_id, revision: record.revision, operation_id: record.operation_id,
    content_hash: record.content_hash, project_id: record.project_id,
    conversation_session_id: record.conversation_session_id,
    conversation_message_id: record.conversation_message_id,
    observed_at: record.observed_at, role: record.role, basis: record.basis, lifecycle,
    source_ids: splitUtf8Spans(record.text, 32 * 1024).map((span) => projectionHash([
      "memory-source", projectionHash(["typed-memory-record", record.source_kind, record.record_id]),
      record.revision, record.source_kind, record.record_id, span.start, span.end, record.content_hash,
    ])),
  }));
}

function sourceInventoryCount(value: unknown): number {
  const inventory = value as { entries?: Array<{ sourceUnitCount?: number }>; typed?: Array<{ source_ids?: string[] }> };
  return (inventory.entries ?? []).reduce((sum, entry) => sum + Number(entry.sourceUnitCount ?? 0), 0) +
    (inventory.typed ?? []).reduce((sum, entry) => sum + (entry.source_ids?.length ?? 0), 0);
}

type LiveMemorySourceWitness = {
  assertCurrent: () => void;
  close: () => void;
};

function exactFileFact(path: string): { exists: false } | { exists: true; bytes: number; sha256: string } {
  if (!fs.existsSync(path)) return { exists: false };
  const bytes = fs.readFileSync(path);
  return { exists: true, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function typedSourceFacts(butlerData: string): unknown {
  const taskIds = new TaskStore(butlerData).taskIds().sort();
  const taskFacts = taskIds.map((taskId) => {
    const root = join(butlerData, "tasks", taskId);
    const attemptsRoot = join(root, "attempts");
    const attempts = fs.existsSync(attemptsRoot) ? fs.readdirSync(attemptsRoot).sort() : [];
    const latest = attempts.at(-1) ?? null;
    return {
      task_id: taskId,
      status: exactFileFact(join(root, "status")),
      eligibility: {
        request: exactFileFact(join(root, "request.md")),
        result: exactFileFact(join(root, "result.md")),
        plan: exactFileFact(join(root, "plan.json")),
        review: exactFileFact(join(root, "review.json")),
        public_report: exactFileFact(join(root, "public-report.md")),
        report_binding: exactFileFact(join(root, "memory-report-binding.json")),
        attempts,
        latest_result: latest ? exactFileFact(join(attemptsRoot, latest, "result.md")) : { exists: false },
      },
    };
  });
  const rulesRoot = join(butlerData, "cognition", "memory", "rules");
  const ruleNames = fs.existsSync(rulesRoot) ? fs.readdirSync(rulesRoot)
    .filter((name: string) => name.endsWith(".md") || name.endsWith(".source.json")).sort() : [];
  return {
    task_facts: taskFacts,
    rules: ruleNames.map((name: string) => [name, exactFileFact(join(rulesRoot, name))]),
    feedback: exactFileFact(join(butlerData, "cognition", "feedback", "feedback.md")),
    feedback_quality: exactFileFact(join(butlerData, "cognition", "feedback", "quality-operations.jsonl")),
  };
}

function openLiveMemorySourceWitness(butlerData: string): LiveMemorySourceWitness {
  const canonicalPath = join(butlerData, "runtime", "conversation-store.sqlite");
  const canonicalIdentity = fs.statSync(canonicalPath);
  const db = new Database(canonicalPath, { readonly: true });
  const dataVersion = () => Number(Object.values(db.query<Record<string, number>, []>("PRAGMA main.data_version").get() ?? {})[0] ?? -1);
  const initialDataVersion = dataVersion();
  const initialTyped = createHash("sha256").update(JSON.stringify(typedSourceFacts(butlerData))).digest("hex");
  let closed = false;
  return {
    assertCurrent: () => {
      const currentIdentity = fs.statSync(canonicalPath);
      const currentTyped = createHash("sha256").update(JSON.stringify(typedSourceFacts(butlerData))).digest("hex");
      if (closed || currentIdentity.dev !== canonicalIdentity.dev || currentIdentity.ino !== canonicalIdentity.ino ||
        dataVersion() !== initialDataVersion || currentTyped !== initialTyped)
        throw new Error("memory_inventory_changed");
    },
    close: () => { if (!closed) { closed = true; db.close(); } },
  };
}

function prepareStableLiveMemorySource(input: {
  butlerData: string;
  signal: AbortSignal;
  deadlineAt: number;
  classifyOrigins?: boolean;
}) {
  const first = readLiveMemorySourceInventory(input.butlerData, {
    classifyOrigins: input.classifyOrigins,
    signal: input.signal,
    deadlineAt: input.deadlineAt,
  });
  const witness = openLiveMemorySourceWitness(input.butlerData);
  try {
    const second = readLiveMemorySourceInventory(input.butlerData, {
      classifyOrigins: false,
      signal: input.signal,
      deadlineAt: input.deadlineAt,
    });
    witness.assertCurrent();
    if (first.sourceInventoryHash !== second.sourceInventoryHash ||
      sourceInventoryCount(first.sourceInventory) !== sourceInventoryCount(second.sourceInventory))
      throw new Error("memory_inventory_changed");
    return { ...second, witness };
  } catch (error) {
    witness.close();
    throw error;
  }
}

function readRebuildQuantumCounters(context: Parameters<typeof resolveMemoryGeneration>[0]) {
  const generation = resolveMemoryGeneration(context);
  const db = new Database(generation.graphPath, { readonly: true });
  try {
    const value = (sql: string) => Number(db.query<{ value: number }, [string]>(sql).get(generation.generationId)?.value ?? 0);
    return {
      semanticAttempts: value("SELECT COUNT(*) value FROM memory_projection_attempts a JOIN memory_projection_jobs j ON j.job_id=a.job_id WHERE j.generation=?"),
      semanticSettled: value("SELECT COUNT(*) value FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id WHERE j.generation=? AND w.state IN ('complete','unsupported','failed')"),
      vector: value("SELECT COALESCE(SUM(u.attempt_count),0) value FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id WHERE j.generation=?"),
      cache: value("SELECT COALESCE(SUM(j.hot_cache_attempt_count),0) value FROM memory_projection_jobs j WHERE j.generation=?"),
    };
  } finally { db.close(); }
}

function readLiveMemorySourceInventory(butlerData: string, options: { classifyOrigins?: boolean; signal?: AbortSignal; deadlineAt?: number } = {}) {
  const origin = options.classifyOrigins !== false
    ? classifyHistoricalConversationOrigins(butlerData, options)
    : { version: "conversation-origin-v1", applied: 0, unchanged: 0, unknown: 0 };
  const revisionReader = new AgentConversationStore({ butlerData });
  const expectedCanonicalRevision = revisionReader.readPublicSourceRevision();
  revisionReader.close();
  const asOf = new Date().toISOString();
  const inventory = canonicalConversationProjectionInventory({
    butlerData, asOf, deadlineAt: options.deadlineAt ?? Date.now() + 60_000,
    scope: "all_user_sessions", currentSessionId: "", currentProjectId: null,
    sessionIds: [], projectFilter: "any", projectIds: [],
  });
  if (!inventory.available || inventory.partial) throw new Error("memory_inventory_incomplete");
  const sourceInventory = { schema: "butler.memory-source-inventory.v1", as_of: asOf, origin,
    exclusions: inventory.exclusions, entries: inventory.entries, typed: typedSourceInventory(butlerData),
    typed_lifecycle: listTypedMemoryLifecycleSnapshot(butlerData) };
  return { sourceInventory, sourceInventoryHash: memorySourceInventoryHash(sourceInventory), expectedCanonicalRevision };
}

function readSnapshotMemorySourceInventory(sourceRoot: string, expected: any) {
  const inventory = canonicalConversationProjectionInventory({
    butlerData: sourceRoot,
    canonicalDbPath: join(sourceRoot, "runtime", "conversation-store.sqlite"),
    asOf: expected.as_of, deadlineAt: Date.now() + 60_000,
    scope: "all_user_sessions", currentSessionId: "", currentProjectId: null,
    sessionIds: [], projectFilter: "any", projectIds: [],
  });
  if (!inventory.available || inventory.partial) throw new Error("memory_inventory_incomplete");
  const sourceInventory = { schema: expected.schema, as_of: expected.as_of, origin: expected.origin,
    exclusions: inventory.exclusions, entries: inventory.entries, typed: typedSourceInventory(sourceRoot),
    typed_lifecycle: listTypedMemoryLifecycleSnapshot(sourceRoot) };
  return { sourceInventory, sourceInventoryHash: memorySourceInventoryHash(sourceInventory) };
}

function classifyHistoricalConversationOrigins(butlerData: string, options: { signal?: AbortSignal; deadlineAt?: number } = {}) {
  const store = new AgentConversationStore({ butlerData });
  const queue = new NativeInboundQueue(butlerData);
  const paths = agentBtccStoragePaths(butlerData);
  const btcc = fs.existsSync(paths.agentBtccDbPath) ? new Database(paths.agentBtccDbPath, { readonly: true }) : null;
  const appPath = paths.legacyAppDbPath;
  let applied = 0, unchanged = 0, unknown = 0, pending = 0;
  const deadlineAt = options.deadlineAt ?? Date.now() + 60_000;
  const record = (row: ReturnType<AgentConversationStore["readOriginCandidatesPage"]>[number], decision: ReturnType<typeof classifyConversationOrigin>) => {
    if (!decision.complete) throw new Error("memory_origin_evidence_unavailable");
    const result = store.recordOriginClassification({ ...row, decision });
    if (result === "applied") applied += 1;
    else if (result === "unchanged") unchanged += 1;
    else if (result === "classification_conflict") throw new Error("memory_origin_classification_conflict");
    else throw new Error("memory_source_changed");
    if (decision.kind === "unknown") unknown += 1;
  };
  try {
    // Requests are classified before outcomes so an assistant can only inherit an
    // origin from the exact, already-classified request referenced by its outcome.
    for (const role of ["user", "assistant"] as const) {
      let after: string | null = null;
      while (true) {
      if (options.signal?.aborted || Date.now() >= deadlineAt) throw new Error("memory_origin_evidence_unavailable");
      const rows = store.readOriginCandidatesPage(after, 100);
      if (!rows.length) break;
      after = rows.at(-1)!.message_id;
      const selected = rows.filter((row) => row.role === role && !row.origin_version);
      const locators = selected.flatMap((row) => row.role === "user" && row.external_session_id && row.source_ref
        ? [{ eventId: row.source_ref, runtimeSessionId: row.external_session_id, turnId: row.turn_id }]
        : []);
      const queueMatches = new Map<string, PersistedOriginEvidence>();
      let queueAvailable = true;
      let queueComplete = locators.length === 0;
      let queueCursor: string | null = null;
      while (locators.length && !queueComplete) {
        const page = queue.readPersistedOriginEvidenceBatch(locators, {
          cursor: queueCursor,
          limit: 500,
          signal: options.signal,
          deadlineAt,
        });
        if (!page.available) { queueAvailable = false; break; }
        for (const [key, value] of page.matches) queueMatches.set(key, value);
        queueComplete = page.complete;
        if (!queueComplete && page.cursor === queueCursor) { queueAvailable = false; break; }
        queueCursor = page.cursor;
      }
      for (const row of rows) {
        if (options.signal?.aborted || Date.now() >= deadlineAt) throw new Error("memory_origin_evidence_unavailable");
        if (row.role !== role) continue;
        if (row.origin_version) { unchanged += 1; continue; }
        if (role === "assistant") {
          if (row.turn_id && !row.outcome_id) { pending += 1; continue; }
          const request = row.outcome_request_message_id ? store.readMessageById(row.outcome_request_message_id) : null;
          const publicResult = row.outcome_public_assistant_message_id === row.message_id && request?.origin_kind === "user_input";
          const internal = request?.origin_kind === "internal_control";
          let decision = classifyConversationOrigin({ ref: row.source_ref, publicIngress: publicResult,
            internalControl: internal,
            // A durable outcome with no request reference proves absence, while a
            // non-null reference still requires the exact classified request.
            evidenceAvailable: !row.outcome_id || row.turn_id === null ||
              row.outcome_request_message_id === null || Boolean(request?.origin_version), evidence: row.outcome_id
              ? [{ kind: "turn_outcome", ref: row.outcome_id, sha256: null }] : [] });
          if (decision.kind === "user_input") decision = { ...decision, kind: "assistant_public" as const, reason: "verified_public_outcome" };
          record(row, decision);
        } else {
          const admission = btcc && row.external_session_id && row.turn_id && row.source_ref
            ? readPersistedConversationAdmissionEvidence(btcc, { canonicalSessionId: row.session_id,
              turnId: row.turn_id, requestId: row.request_id, sourceRef: row.source_ref,
              gateway: row.source_gateway, runtimeSessionId: row.external_session_id })
            : { available: true, matched: false, publicIngress: false, internalControl: false, evidence: [] };
          const app = readHistoricalAppOriginEvidence({ dbPath: appPath, canonicalSessionId: row.session_id,
            canonicalTurnId: row.turn_id, canonicalMessageId: row.message_id, externalSessionId: row.external_session_id });
          const inbound = row.source_ref
            ? queueMatches.get(row.source_ref) ?? { matched: false, internalControl: false, ref: null, sha256: null }
            : { matched: false, internalControl: false, ref: null, sha256: null };
          const evidence = [...admission.evidence,
            ...(app.matched && app.ref ? [{ kind: "app_ingress" as const, ref: app.ref, sha256: app.sha256 }] : []),
            ...(inbound.matched && inbound.ref ? [{ kind: "gateway_ingress" as const, ref: inbound.ref, sha256: inbound.sha256 }] : [])];
          const internal = admission.internalControl || app.internalControl || inbound.internalControl;
          const positive = admission.publicIngress || app.matched && !app.internalControl || inbound.matched && !inbound.internalControl;
          const decision = classifyConversationOrigin({ ref: row.source_ref, publicIngress: positive,
            internalControl: internal,
            evidenceAvailable: positive || internal || admission.available && app.available && queueAvailable && queueComplete,
            evidence });
          record(row, decision);
        }
      }
      if (rows.length < 100) break;
      }
    }
    return { version: "conversation-origin-v1", applied, unchanged, unknown, pending };
  } finally { btcc?.close(); store.close(); }
}


export async function runConfiguredMemoryConsolidation(input: { butlerData: string }): Promise<ConsolidationCycleResult> {
const data = input.butlerData;
const cfg = loadConfig(data);
if (!cfg.enabled) {
  const r = await runConsolidationCycle(cfg, {
    runCatchup: async () => ({}),
    runConsolidate: async () => ({}),
    runOptimize: async () => ({}),
    runHealth: async () => ({}),
    assertWriteAuthority: () => {},
  });
  return r;
}
const sc = loadRawConsolidationCycle(data);
const consolidationDir = cognitionConsolidationRoot(data);
fs.mkdirSync(consolidationDir, { recursive: true });
if (!fs.existsSync(activeMemoryDescriptorPath(data))) return { exitCode: 0, skipped: true, phasesRun: 0 };
const descriptor = readActiveDescriptor(data);
const deadlineAt = Date.now() + cfg.totalBudgetMs;
const generationContext = {
  butlerData: data,
  target: { kind: "active" as const, expected_generation: descriptor.generation_id },
  signal: new AbortController().signal,
  deadlineAt,
  waitClass: "background" as const,
};
const generation = resolveMemoryGeneration(generationContext);
const db = openProjectionDb(generation.graphPath);
const assertActiveGeneration = (): void => {
  if (readActiveDescriptor(data).generation_id !== generation.generationId) {
    throw new Error("memory_generation_changed");
  }
};

const decayD = sc.activationDecayD ?? 0.5;
const edgeBoostWindowMs = 7 * 86400_000;

const deps: ConsolidationCyclePhaseDeps = {
  runCatchup: async () => {
    const mod = await import("./phases/catchup.ts");
    return await mod.runServingGenerationCatchup({ butlerData: data, limit: 256 }) as unknown as Record<string, unknown>;
  },
  runConsolidate: async () => {
    assertActiveGeneration();
    return await runConsolidateWithMemoryGate({
      db,
      nowMs: Date.now(),
      decayD,
      edgeBoostWindowMs,
    }, generationContext) as unknown as Record<string, unknown>;
  },
  runOptimize: async () => {
    const { runRevisionAwareOptimize } = await import("./phases/optimize.ts");
    const lance = await import("@lancedb/lancedb");
    const connection = await lance.connect(join(generation.root, "butler.lance"));
    let table;
    try {
      table = await connection.openTable("butler_memory");
    } catch {
      return { available: false, reason: "vector_store_unavailable", vectors_pruned: 0 };
    }
    return await runRevisionAwareOptimize({ db, table, context: generationContext }) as unknown as Record<string, unknown>;
  },
  runProjectCapsules: async () => {
    assertActiveGeneration();
    const projectCapsules = await refreshRegisteredProjectCapsules({
      butlerData: data,
      maxProjects: sc.projectCapsuleRefreshLimit ?? 20,
      signal: generationContext.signal,
      deadlineAt,
    });
    return {
      project_capsules_considered: projectCapsules.considered,
      project_capsules_refreshed: projectCapsules.refreshed,
      project_capsule_failures: projectCapsules.failed.length,
    };
  },
  runHealth: async () => readMemoryHealth({ butlerData: data }) as unknown as Record<string, unknown>,
  assertWriteAuthority: assertActiveGeneration,
};

try {
  return await runConsolidationCycle(cfg, deps);
} finally {
  try {
    db.close();
  } catch {}
}
}
