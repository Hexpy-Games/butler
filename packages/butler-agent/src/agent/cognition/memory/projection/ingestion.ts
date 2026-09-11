import { createLazyConversationProjectionReader } from "../../../conversation/projection-reader-store.ts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readProfilingExtractorModelConfig } from "../../../../personalization/profiling.ts";
import type { ConversationMessageWithParts, ConversationProjectionReader } from "../../../conversation/types.ts";
import {
  readActiveDescriptor,
  resolveMemoryGeneration,
  assertMemoryGenerationMutationAuthority,
  bindObservedGenerationEmbeddingUnderWriteGate,
  type MemoryGenerationHandle,
} from "./generation.ts";
import {
  MEMORY_EXTRACTION_VERSION,
  type ExtractInput,
  type ExtractOutput,
  type MemoryExecutionContext,
  type MemoryJobProgress,
  type MemorySourceNotice,
  type ResolvedMemorySource,
} from "./contracts.ts";
import {
  claimNextProjectionWindow,
  claimNextVectorQuantum,
  completeVectorQuantum,
  expandSplitSourceLeaves,
  failVectorQuantum,
  ensureV2MemorySchema,
  installAndBackfillRecallIndexes,
  markWindowFailure,
  markPlannedWindowFailure,
  markVectorRegistrationFailure,
  openProjectionDb,
  progressFromDb,
  recordWindowAttemptFailure,
  recordProviderInvocationIntent,
  recordVectorInvocationStarted,
  refreshSemanticState,
  refreshVectorUnitsForJob,
  saveValidatedPlan,
  saveAttemptResult,
  invalidatePlannedWindow,
  selectNextProjectionJob,
  pinWindowInput,
  splitProjectionWindow,
  sourceRows,
  type ProjectionSourceRow,
  vectorRegistrationFailureStage,
} from "./store.ts";
import { embedVectorQuantum, filterCurrentGenerationVectorMatches, findPersistedVectorReceipt, prepareReusedGenerationVectorRows, searchGenerationVectors, writeGenerationVectorRows } from "../recall/vector.ts";
import { selectSemanticSeeds } from "../recall/candidates.ts";
import { MemoryExtractAttemptError, runStructuredMemoryExtractor } from "./extractor.ts";
import {
  acquireConsolidationLock,
  acquireConsolidationLockAsync,
  consolidationLockPath,
  releaseConsolidationLock,
} from "../scripts/lib/lock.ts";
import {
  combinedOrigin,
  decodeMessageScalars,
  hydrateSource,
  packWindows,
  projectionHash,
  readPriorPublicContext,
  splitUtf8Spans,
} from "./source.ts";
import {
  applyPlan,
  assertPlanCandidatesCurrent,
  assertPlanSourceCurrent,
  normalizeAndValidatePlan,
  safeProjectionError,
  type NormalizedPlan,
} from "./plan.ts";
import { ModelProviderRequestError } from "../../../../integrations/providers/provider-request-errors.ts";
import type { ProviderStreamProjectionHandler } from "../../../../integrations/providers/runtime-contracts.ts";
import { writeSemanticHotCacheEntry } from "../../continuity/hot-cache-writer.ts";
import {
  enforceExtractInputBudget,
  packExtractionCandidates,
  jsonBytes,
  MEMORY_EXTRACT_INPUT_BYTES,
  MEMORY_SOURCE_WINDOW_BYTES,
  nearestGraphemeByteMidpoint,
} from "./windows.ts";
import { invalidateIdentityBindingsForSupersededSources } from "./identity.ts";
import {
  readExplicitMemoryLifecycle,
  readTaskMemoryNoticeLifecycle,
  readTypedMemoryRecord,
} from "../quality.ts";

const MAX_WINDOW_BYTES = MEMORY_SOURCE_WINDOW_BYTES;
const MAX_CANDIDATE_BYTES = 8 * 1024;

type WindowReprocessRequest = {
  schema: "butler.memory.window-reprocess.v1";
  operation_id: string;
  expected_generation: string;
  job_id: string;
  window_ref: string;
  expected_source_revision: string;
  expected_recovery_revision: string | null;
  expected_attempt_count: number;
  expected_failed_attempt_ref: string;
  expected_error_code: string;
  expected_input_sha256: string;
  expected_model: string;
  expected_reasoning_effort: string;
};

export async function repairMemoryCandidateInputs(input: {
  context: MemoryExecutionContext;
  request: unknown;
  dryRun?: boolean;
}) {
  const request = input.request as {
    schema?: unknown;
    windows?: Array<{ window_ref: string; expected_input_sha256: string; expected_attempt_count: number; candidate_source_sha256?: string }>;
  } | null;
  if (!request || request.schema !== "butler.memory-candidate-input-repair.v1" ||
    !Array.isArray(request.windows) || !request.windows.length || request.windows.length > 32 ||
    Object.keys(request).some((key) => key !== "schema" && key !== "windows") ||
    request.windows.some((row) => !row || typeof row !== "object" ||
      Object.keys(row).some((key) => !["window_ref", "expected_input_sha256", "expected_attempt_count", "candidate_source_sha256"].includes(key)) ||
      typeof row.window_ref !== "string" || !/^[a-f0-9]{64}$/u.test(row.window_ref) ||
      typeof row.expected_input_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.expected_input_sha256) ||
      !Number.isSafeInteger(row.expected_attempt_count) || row.expected_attempt_count < 0 ||
      (row.candidate_source_sha256 !== undefined && (typeof row.candidate_source_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.candidate_source_sha256)))) ||
    new Set(request.windows.map((row) => row.window_ref)).size !== request.windows.length) {
    throw new Error("memory_input_repair_invalid_request");
  }
  const generation = resolveMemoryGeneration(input.context);
  const db = openProjectionDb(generation.graphPath);
  try {
    return await withMemoryWriteGateAsync(input.context, () => db.transaction(() => {
      const receipts = [];
      for (const expected of request.windows!) {
        const row = db.query<{
          job_id: string; state: string; input_json: string | null; input_sha256: string | null;
          output_json: string | null; normalized_plan_json: string | null;
          owner_nonce: string | null; owner_pid: number | null; attempt_count: number; recovery_revision: string | null;
        }, [string]>("SELECT * FROM memory_projection_windows WHERE window_ref=?").get(expected.window_ref);
        const eligibleState = row && (row.state === "pending" || (input.dryRun && row.state === "complete"));
        if (!row || !eligibleState || row.owner_nonce !== null || row.owner_pid !== null ||
          (!input.dryRun && (row.output_json !== null || row.normalized_plan_json !== null)) || !row.input_json ||
          row.input_sha256 !== expected.expected_input_sha256 || row.attempt_count !== expected.expected_attempt_count ||
          projectionHash(["extract-input", row.input_json]) !== row.input_sha256) {
          throw new Error("memory_input_repair_precondition_changed");
        }
        const pinned = JSON.parse(row.input_json) as ExtractInput;
        if (pinned.schema !== "butler.memory-extract-input.v2" || pinned.window_ref !== expected.window_ref)
          throw new Error("memory_input_repair_precondition_changed");
        if (!input.dryRun && db.query(`SELECT 1 FROM memory_projection_attempts a
          WHERE a.window_ref=? AND a.provider_invoked=1 AND a.outcome_known=0
          AND NOT EXISTS(SELECT 1 FROM memory_projection_attempts settled
            WHERE settled.window_ref=a.window_ref AND settled.invocation_ref=a.invocation_ref AND settled.outcome_known=1)
          LIMIT 1`).get(expected.window_ref)) {
          throw new Error("memory_input_repair_precondition_changed");
        }
        assertProjectionSourceCurrent(generation.sourceRoot, db, pinned);
        let candidateSource = pinned;
        if (expected.candidate_source_sha256 && expected.candidate_source_sha256 !== row.input_sha256) {
          const archived = db.query<{ recovery_request_json: string }, [string, string]>(`SELECT recovery_request_json
            FROM memory_projection_attempts WHERE window_ref=? AND attempt_kind='recovery'
            AND json_extract(recovery_request_json,'$.schema')='butler.memory-candidate-input-repair-receipt.v1'
            AND json_extract(recovery_request_json,'$.prior_input_sha256')=? LIMIT 1`)
            .get(expected.window_ref, expected.candidate_source_sha256);
          if (!archived) throw new Error("memory_input_repair_precondition_changed");
          const previousJson = (JSON.parse(archived.recovery_request_json) as { prior_input_json: string }).prior_input_json;
          if (projectionHash(["extract-input", previousJson]) !== expected.candidate_source_sha256)
            throw new Error("memory_input_repair_precondition_changed");
          candidateSource = JSON.parse(previousJson) as ExtractInput;
          for (const field of ["schema", "episode_ref", "revision", "window_ref", "bound_project_id", "source_units", "context_units"] as const) {
            if (JSON.stringify(candidateSource[field]) !== JSON.stringify(pinned[field]))
              throw new Error("memory_input_repair_precondition_changed");
          }
        }
        const emptyCandidateInput: ExtractInput = { ...pinned, candidates: [] };
        const candidateBytes = MEMORY_EXTRACT_INPUT_BYTES - jsonBytes(emptyCandidateInput) + jsonBytes([]);
        if (candidateBytes < jsonBytes([])) throw new Error("memory_extract_input_exceeds_budget");
        const repaired: ExtractInput = { ...pinned, candidates: loadSourceWindowCandidates({
          db, butlerData: generation.sourceRoot, projectId: pinned.bound_project_id,
          ids: candidateSource.candidates.map((candidate) => candidate.ref),
          candidateBytes,
        }) };
        if (jsonBytes(repaired) > MEMORY_EXTRACT_INPUT_BYTES)
          throw new Error("memory_extract_input_exceeds_budget");
        const repairedRefs = new Set(repaired.candidates.map((candidate) => candidate.ref));
        if (candidateSource.candidates.some((candidate) => !repairedRefs.has(candidate.ref)))
          throw new Error("memory_input_repair_candidates_incomplete");
        if (input.dryRun) {
          receipts.push({ window_ref: expected.window_ref, state: "preview",
            prior_input_sha256: row.input_sha256,
            repaired_input_sha256: projectionHash(["extract-input", JSON.stringify(repaired)]),
            repaired_candidates: repaired.candidates });
          continue;
        }
        if (JSON.stringify(repaired.candidates) === JSON.stringify(pinned.candidates)) {
          receipts.push({ window_ref: expected.window_ref, state: "unchanged", input_sha256: row.input_sha256 });
          continue;
        }
        const serialized = JSON.stringify(repaired);
        const digest = projectionHash(["extract-input", serialized]);
        const receiptRef = projectionHash(["candidate-input-repair", expected.window_ref, row.input_sha256, digest]);
        const now = new Date().toISOString();
        db.query(`INSERT INTO memory_projection_attempts
          (attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,recorded_at,
           attempt_kind,provider_invoked,outcome_known,recovery_revision,recovery_request_json)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          receiptRef, expected.window_ref, row.job_id, row.attempt_count, `input_repaired:${receiptRef}`, null,
          row.input_sha256, now, "recovery", 0, 1, row.recovery_revision,
          JSON.stringify({ schema: "butler.memory-candidate-input-repair-receipt.v1",
            prior_input_json: row.input_json, prior_input_sha256: row.input_sha256,
            repaired_input_sha256: digest, candidate_source_sha256: expected.candidate_source_sha256 ?? row.input_sha256, repaired_at: now }),
        );
        db.query("UPDATE memory_projection_windows SET input_json=?,input_sha256=? WHERE window_ref=?")
          .run(serialized, digest, expected.window_ref);
        receipts.push({ window_ref: expected.window_ref, state: "repaired", input_sha256: digest, receipt_ref: receiptRef });
      }
      return { repaired: receipts.filter((row) => row.state === "repaired").length, receipts };
    })());
  } finally { db.close(); }
}

export function reprocessMemoryProjectionWindow(input: {
  context: MemoryExecutionContext;
  request: unknown;
}) {
  const request = parseWindowReprocessRequest(input.request);
  if (input.context.signal.aborted) throw new Error("memory_projection_aborted");
  const result = withMemoryWriteGate(input.context, () => reprocessMemoryProjectionWindowOwned(input.context, request));
  if (result.action === "split") refreshProjectionVectors(input.context, result.job_id);
  return result;
}

export async function reprocessMemoryProjectionWindowAsync(input: {
  context: MemoryExecutionContext;
  request: unknown;
}) {
  const request = parseWindowReprocessRequest(input.request);
  if (input.context.signal.aborted) throw new Error("memory_projection_aborted");
  const result = await withMemoryWriteGateAsync(input.context, () => reprocessMemoryProjectionWindowOwned(input.context, request));
  if (result.action === "split") await refreshProjectionVectorsAsync(input.context, result.job_id);
  return result;
}

function reprocessMemoryProjectionWindowOwned(context: MemoryExecutionContext, request: WindowReprocessRequest) {
    const generation = resolveMemoryGeneration(context);
    if (generation.generationId !== request.expected_generation) throw new Error("memory_generation_changed");
    const db = openProjectionDb(generation.graphPath);
    try {
      return db.transaction(() => {
        ensureV2MemorySchema(db);
        const receiptRef = projectionHash(["memory-window-reprocess", request.operation_id]);
        const requestDigest = projectionHash(Object.keys(request).sort().map((key) => [key, request[key as keyof WindowReprocessRequest]]));
        const existing = db.query<{ recovery_request_json: string | null }, [string]>(
          "SELECT recovery_request_json FROM memory_projection_attempts WHERE attempt_ref=?",
        ).get(receiptRef);
        if (existing) {
          const receipt = existing.recovery_request_json ? JSON.parse(existing.recovery_request_json) : null;
          if (receipt?.request_digest !== requestDigest) throw new Error("memory_reprocess_operation_conflict");
          const current = db.query<{ state: string; next_attempt_at: string | null; attempt_count: number; recovery_revision: string | null }, [string]>(
            "SELECT state,next_attempt_at,attempt_count,recovery_revision FROM memory_projection_windows WHERE window_ref=?",
          ).get(request.window_ref);
          if (!current) throw new Error("memory_projection_window_changed");
          const revisionAttempt = db.query<{ attempt_count: number }, [string, string]>(
            "SELECT MAX(attempt_count) attempt_count FROM memory_projection_attempts WHERE window_ref=? AND recovery_revision=?",
          ).get(request.window_ref, receiptRef)!;
          return {
            ...receipt.result,
            cumulative_attempt_count: current.attempt_count,
            recovery_attempt_count: (current.recovery_revision === receiptRef ? current.attempt_count : revisionAttempt.attempt_count) - receipt.base_attempt_count,
            current_recovery_revision: current.recovery_revision,
            state: current.state, next_attempt_at: current.next_attempt_at, replayed: true,
            ...(receipt.result.action === "split" ? {
              children: readReprocessChildren(db, receipt.result.children.map((child: { window_ref: string }) => child.window_ref), receiptRef),
            } : {}),
          };
        }
        const row = db.query<{
          state: string; error_code: string | null; job_id: string; episode_id: string; revision: string;
          generation: string; extraction_model: string; reasoning_effort: string; attempt_count: number;
          recovery_revision: string | null; recovery_base_attempt_count: number;
          input_json: string | null; input_sha256: string | null; normalized_plan_json: string | null;
          source_refs_json: string;
        }, [string]>(`SELECT w.*,j.episode_id,j.revision,j.generation,j.extraction_model,j.reasoning_effort
          FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id WHERE w.window_ref=?`).get(request.window_ref);
        const failed = db.query<{ window_ref: string; job_id: string; attempt_count: number; state: string; error_code: string | null; input_sha256: string | null; recovery_revision: string | null }, [string]>(
          "SELECT window_ref,job_id,attempt_count,state,error_code,input_sha256,recovery_revision FROM memory_projection_attempts WHERE attempt_ref=?",
        ).get(request.expected_failed_attempt_ref);
        if (!row || row.state !== "failed" || row.job_id !== request.job_id || row.generation !== request.expected_generation ||
          row.revision !== request.expected_source_revision || row.recovery_revision !== request.expected_recovery_revision ||
          row.attempt_count !== request.expected_attempt_count || row.error_code !== request.expected_error_code ||
          row.input_sha256 !== request.expected_input_sha256 || !row.input_json ||
          row.extraction_model !== request.expected_model || row.reasoning_effort !== request.expected_reasoning_effort ||
          !failed || failed.window_ref !== request.window_ref || failed.job_id !== request.job_id || failed.state !== "failed" ||
          failed.attempt_count !== row.attempt_count || failed.error_code !== row.error_code ||
          failed.input_sha256 !== row.input_sha256 || failed.recovery_revision !== row.recovery_revision)
          throw new Error("memory_reprocess_preimage_changed");
        const pinned = JSON.parse(row.input_json) as ExtractInput;
        if (projectionHash(["extract-input", row.input_json]) !== row.input_sha256 || pinned.schema !== "butler.memory-extract-input.v2" ||
          pinned.episode_ref !== row.episode_id || pinned.revision !== row.revision || pinned.window_ref !== request.window_ref ||
          JSON.stringify(pinned.source_units.map((unit) => unit.ref)) !== row.source_refs_json)
          throw new Error("memory_reprocess_input_changed");
        assertProjectionSourceCurrent(generation.sourceRoot, db, pinned);
        const now = new Date().toISOString();
        const exhaustedLocalTimeout = hasExhaustedLocalTimeoutBudget(db, request.window_ref);
        const childRefs = exhaustedLocalTimeout
          ? splitExhaustedLocalTimeoutWindow(generation.sourceRoot, db, request.window_ref, receiptRef)
          : null;
        const state = childRefs ? "replaced" : row.normalized_plan_json ? "planned" : "pending";
        const result = {
          ok: true, job_id: request.job_id, window_ref: request.window_ref,
          action: childRefs ? "split" : "retry",
          recovery_revision: receiptRef, prior_recovery_revision: row.recovery_revision,
          cumulative_attempt_count: row.attempt_count, recovery_attempt_count: 0, budget: childRefs ? 0 : 3,
          state, next_attempt_at: childRefs ? null : now, replayed: false, receipt_ref: receiptRef,
          ...(childRefs ? { children: readReprocessChildren(db, childRefs, receiptRef) } : {}),
        };
        const receipt = { request_digest: requestDigest, approved_at: now, reason: childRefs ? "local_deadline_budget_exhausted" : "operator_requested_reprocess",
          prior_recovery_revision: row.recovery_revision, prior_base_attempt_count: row.recovery_base_attempt_count,
          base_attempt_count: row.attempt_count, request, result };
        db.query(`INSERT INTO memory_projection_attempts
          (attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,recorded_at,attempt_kind,provider_invoked,outcome_known,invocation_ref,recovery_revision,recovery_request_json)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(receiptRef, request.window_ref, request.job_id, row.attempt_count,
            "recovery_requested", row.error_code, row.input_sha256, now, "recovery", 0, 1, null, receiptRef, JSON.stringify(receipt));
        if (!childRefs) db.query(`UPDATE memory_projection_windows SET recovery_revision=?,recovery_base_attempt_count=?,state=?,next_attempt_at=?,
          owner_pid=NULL,owner_nonce=NULL,started_at=NULL WHERE window_ref=?`)
          .run(receiptRef, row.attempt_count, state, now, request.window_ref);
        refreshSemanticState(db, request.job_id);
        return result;
      })();
    } finally { db.close(); }
}

function readReprocessChildren(db: ReturnType<typeof openProjectionDb>, refs: string[], requestedRevision: string) {
  return refs.map((ref) => {
    const row = db.query<{ state: string; attempt_count: number; recovery_revision: string | null; next_attempt_at: string | null }, [string]>(
      "SELECT state,attempt_count,recovery_revision,next_attempt_at FROM memory_projection_windows WHERE window_ref=?",
    ).get(ref);
    if (!row) throw new Error("memory_projection_window_changed");
    const attempt = row.recovery_revision === requestedRevision ? row.attempt_count
      : db.query<{ n: number | null }, [string, string]>(
        "SELECT MAX(attempt_count) n FROM memory_projection_attempts WHERE window_ref=? AND recovery_revision=?",
      ).get(ref, requestedRevision)?.n ?? 0;
    return { window_ref: ref, recovery_revision: requestedRevision, current_recovery_revision: row.recovery_revision,
      state: row.state, cumulative_attempt_count: row.attempt_count, recovery_attempt_count: attempt,
      next_attempt_at: row.next_attempt_at, budget: 3 };
  });
}

function parseWindowReprocessRequest(value: unknown): WindowReprocessRequest {
  const fields = ["schema", "operation_id", "expected_generation", "job_id", "window_ref", "expected_source_revision",
    "expected_recovery_revision", "expected_attempt_count", "expected_failed_attempt_ref", "expected_error_code",
    "expected_input_sha256", "expected_model", "expected_reasoning_effort"];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("memory_reprocess_invalid_request");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== fields.length || fields.some((key) => {
    if (key === "expected_attempt_count") return !Number.isSafeInteger(row[key]) || Number(row[key]) < 1;
    if (key === "expected_recovery_revision" && row[key] === null) return false;
    return typeof row[key] !== "string" || !(row[key] as string).trim() || (row[key] as string).length > 512;
  }) || row.schema !== "butler.memory.window-reprocess.v1" || !/^[a-f0-9]{64}$/u.test(String(row.expected_input_sha256)))
    throw new Error("memory_reprocess_invalid_request");
  return value as WindowReprocessRequest;
}

export async function ingestConversationMemory(input: {
  context: MemoryExecutionContext;
  source: MemorySourceNotice;
  completionJobId?: string;
}): Promise<MemoryJobProgress> {
  if (input.context.signal.aborted)
    throw new Error("memory_projection_aborted");
  const generation = resolveMemoryGeneration(input.context);
  const sourceRoot = generation.sourceRoot;
  if (input.source.kind === "task_report" || input.source.kind === "explicit_record") {
    return ingestTypedMemoryRecord(input as {
      context: MemoryExecutionContext;
      source: Extract<MemorySourceNotice, { kind: "task_report" | "explicit_record" }>;
      completionJobId?: string;
    }, generation);
  }
  const canonical = createLazyConversationProjectionReader({
    butlerData: generation.sourceRoot,
    dbPath: generation.canonicalSnapshotPath ?? undefined,
  });
  try {
    const conversationSource = input.source as Extract<MemorySourceNotice, { kind: "conversation_turn" | "conversation_message" }>;
    const turn = input.source.kind === "conversation_turn" ? canonical.readTurn(input.source.turn_id) : null;
    const outcome = input.source.kind === "conversation_turn" ? canonical.readTurnOutcome(input.source.turn_id) : null;
    let messages: ConversationMessageWithParts[];
    let sourceKey: string;
    let episodeId: string;
    let revisionTail: unknown;
    if (input.source.kind === "conversation_turn") {
      if (!turn || !outcome || turn.session_id !== input.source.session_id || outcome.generation !== input.source.outcome_generation ||
        !["complete", "failed", "aborted"].includes(turn.status)) throw new Error("memory_source_not_terminal");
      messages = eligibleCanonicalMessages(canonical, outcome, "memory_source_ineligible");
      sourceKey = `conversation_turn:${turn.id}`;
      episodeId = projectionHash(["canonical-conversation-turn", turn.id]);
      revisionTail = outcome.generation;
    } else {
      const message = canonical.readMessageById(input.source.message_id);
      if (!message || message.session_id !== input.source.session_id || !eligibleStandaloneMessage(message))
        throw new Error("memory_source_not_terminal");
      if (input.source.source_hash !== recoveredMessageSourceHash(message))
        throw new Error("memory_source_changed");
      messages = [message];
      sourceKey = `conversation_message:${message.id}`;
      episodeId = projectionHash(["canonical-conversation-message", message.id]);
      revisionTail = input.source.source_hash;
    }
    const scalars = messages.flatMap(decodeMessageScalars);
    if (scalars.length === 0) throw new Error("memory_source_text_missing");
    const revision = projectionHash([
      "episode-revision",
      ...scalars.flatMap((s) => [s.message.id, s.part.id, s.pointer, s.hash]),
      revisionTail,
    ]);
    const jobId = projectionHash([
      "memory-projection",
      episodeId,
      revision,
      MEMORY_EXTRACTION_VERSION,
    ]);
    const model = readProfilingExtractorModelConfig(generation.sourceRoot);
    const db = openProjectionDb(generation.graphPath);
    try {
      await withMemoryWriteGateAsync(input.context, () => ensureV2MemorySchema(db));
      await withMemoryWriteGateAsync(input.context, () =>
        db.transaction(() => {
          assertCanonicalNoticeCurrent(canonical, input.source, revision);
          const now = new Date().toISOString();
          const priorRevision = db.query<{ current_revision: string }, [string]>("SELECT current_revision FROM memory_chunks WHERE source_key=?").get(sourceKey)?.current_revision;
          const priorSourceIds = priorRevision
            ? db.query<{ source_id: string }, [string, string]>("SELECT source_id FROM memory_chunk_sources WHERE episode_id=? AND revision=? ORDER BY source_id").all(episodeId, priorRevision).map((row) => row.source_id)
            : [];
          db.query(
            `INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,conversation_start,conversation_end,project_id,origin_kind,status,source_hash,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?) ON CONFLICT(source_key) DO UPDATE SET
            current_revision=excluded.current_revision,updated_at=excluded.updated_at,
            summary=CASE WHEN memory_chunks.current_revision!=excluded.current_revision THEN '' ELSE memory_chunks.summary END,
            summary_status=CASE WHEN memory_chunks.current_revision!=excluded.current_revision THEN 'pending' ELSE memory_chunks.summary_status END`,
          ).run(
            episodeId,
            sourceKey,
            revision,
            conversationSource.session_id,
            turn?.id ?? null,
            messages[0]?.created_at ?? turn?.started_at ?? new Date().toISOString(),
            messages.at(-1)?.created_at ?? turn?.completed_at ?? messages[0]!.created_at,
            canonical.getSession(conversationSource.session_id)?.project_id ?? null,
            combinedOrigin(messages),
            revision,
            now,
            now,
          );
          const completionIds = new Set<string>(input.completionJobId ? [input.completionJobId] : []);
          const existingIds = db.query<{ observed_completion_job_ids: string }, [string]>("SELECT observed_completion_job_ids FROM memory_projection_jobs WHERE job_id=?").get(jobId);
          const existingJob = Boolean(existingIds);
          if (existingIds) for (const id of JSON.parse(existingIds.observed_completion_job_ids) as string[]) completionIds.add(id);
          db.query(
            "INSERT OR IGNORE INTO entities(id,type,label_original,properties,identity_scope,project_id,created_at) VALUES(?,'episode',?,'{}','user',NULL,?)",
          ).run(episodeId, episodeId, now);
          const registered: string[] = [];
          for (const scalar of scalars)
            for (const span of splitUtf8Spans(scalar.text, MAX_WINDOW_BYTES)) {
              const sourceId = projectionHash([
                "memory-source",
                episodeId,
                revision,
                "conversation",
                scalar.message.id,
                scalar.part.id,
                scalar.pointer,
                span.start,
                span.end,
                scalar.hash,
              ]);
              const replacementRefs = replacementSourceRefs(db, sourceId);
              if (replacementRefs.length) {
                registered.push(...replacementRefs);
                continue;
              }
              db.query(
                `INSERT OR IGNORE INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis)
            VALUES(?,?,?,'conversation',?,?,?,?,?,?,?,?,?,?,?)`,
              ).run(
                sourceId,
                episodeId,
                revision,
                scalar.message.session_id,
                scalar.message.id,
                scalar.part.id,
                scalar.pointer,
                span.start,
                span.end,
                scalar.hash,
                scalar.message.role,
                scalar.message.origin_kind ?? "unknown",
                scalar.message.created_at,
                scalar.message.role === "user"
                  ? "user_statement"
                  : "assistant_statement",
              );
              registered.push(sourceId);
            }
          const sourceState = {
            state: "complete",
            completed_units: registered.length,
            total_units: registered.length,
          };
          const pending = { state: "pending", blocked_by: null };
          db.query(
            `INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(episode_id,revision,extraction_version) DO UPDATE SET observed_completion_job_ids=excluded.observed_completion_job_ids`,
          ).run(
            jobId,
            episodeId,
            revision,
            MEMORY_EXTRACTION_VERSION,
            generation.generationId,
            model.effective_model,
            model.reasoning_effort,
            JSON.stringify([...completionIds].sort()),
            JSON.stringify(sourceState),
            JSON.stringify(pending),
            JSON.stringify(pending),
            JSON.stringify(pending),
            JSON.stringify(pending),
            now,
          );
          if (!existingJob) {
            const windows = packWindows(registered, db, MAX_WINDOW_BYTES);
            windows.forEach((refs, index) => {
              const oversized = sourceRows(db, refs).some((row) => row.byte_end - row.byte_start > MAX_WINDOW_BYTES);
              db.query("INSERT INTO memory_projection_windows(window_ref,job_id,ordinal,source_refs_json,state,error_code) VALUES(?,?,?,?,?,?)")
                .run(projectionHash(["memory-window", revision, ...refs]), jobId, index, JSON.stringify(refs), oversized ? "failed" : "pending", oversized ? "input_unit_exceeds_budget" : null);
            });
          }
          if (priorRevision && priorRevision !== revision) invalidateIdentityBindingsForSupersededSources(db, {
            butlerData: generation.sourceRoot,
            oldSourceIds: priorSourceIds,
            newJobId: jobId,
            newEpisodeId: episodeId,
            newRevision: revision,
            recordedAt: now,
          });
          refreshSemanticState(db, jobId);
        })(),
      );
      const vectorText = episodeProjectionTextForJob(generation.sourceRoot, db, jobId);
      await withMemoryWriteGateAsync(input.context, () => {
        assertJobRevisionCurrent(generation.sourceRoot, db, jobId);
        refreshVectorUnitsForJob(db, jobId, vectorText);
      });
      return progressFromDb(db, jobId);
    } finally {
      db.close();
    }
  } finally {
    canonical.close();
  }
}

async function ingestTypedMemoryRecord(
  input: {
    context: MemoryExecutionContext;
    source: Extract<MemorySourceNotice, { kind: "task_report" | "explicit_record" }>;
    completionJobId?: string;
  },
  generation: MemoryGenerationHandle,
): Promise<MemoryJobProgress> {
  const owner = readTypedMemoryRecord(
    generation.sourceRoot,
    input.source.kind,
    input.source.record_id,
    { unavailable: "throw" },
  );
  if (!owner || owner.revision !== input.source.revision || owner.operation_id !== input.source.operation_id) {
    if (input.source.kind === "explicit_record" && input.source.record_kind === "rule") {
      const lifecycle = readExplicitMemoryLifecycle({
        butlerData: generation.sourceRoot,
        recordId: input.source.record_id,
        operationId: input.source.operation_id,
        revision: input.source.revision,
      }, { unavailable: "throw" });
      if (lifecycle === "forgotten" || lifecycle === "superseded") {
        return consumeTypedMemoryLifecycle(input.context, generation, input.source, lifecycle);
      }
    }
    if (input.source.kind === "task_report" &&
      readTaskMemoryNoticeLifecycle({
        butlerData: generation.sourceRoot,
        recordId: input.source.record_id,
        operationId: input.source.operation_id,
        revision: input.source.revision,
      }, { unavailable: "throw" }) === "superseded") {
      return consumeTypedMemoryLifecycle(input.context, generation, input.source, "superseded");
    }
    throw new Error("memory_source_changed");
  }
  const episodeId = projectionHash(["typed-memory-record", owner.source_kind, owner.record_id]);
  const jobId = projectionHash(["memory-projection", episodeId, owner.revision, MEMORY_EXTRACTION_VERSION]);
  const db = openProjectionDb(generation.graphPath);
  try {
    const model = readProfilingExtractorModelConfig(generation.sourceRoot);
    await withMemoryWriteGateAsync(input.context, () => ensureV2MemorySchema(db));
    await withMemoryWriteGateAsync(input.context, () => db.transaction(() => {
      const current = readTypedMemoryRecord(
        generation.sourceRoot,
        owner.source_kind,
        owner.record_id,
        { unavailable: "throw" },
      );
      if (!current || current.revision !== owner.revision || current.operation_id !== owner.operation_id)
        throw new Error("memory_source_changed");
      const now = new Date().toISOString();
      db.query(`INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,conversation_start,conversation_end,project_id,origin_kind,status,source_hash,created_at,updated_at)
        VALUES(?,?,?,?,NULL,?,?,?,?, 'active',?,?,?)
        ON CONFLICT(source_key) DO UPDATE SET
          current_revision=excluded.current_revision,
          conversation_session_id=excluded.conversation_session_id,
          conversation_start=excluded.conversation_start,
          conversation_end=excluded.conversation_end,
          project_id=excluded.project_id,
          origin_kind=excluded.origin_kind,
          status='active',
          source_hash=excluded.source_hash,
          updated_at=excluded.updated_at`)
        .run(episodeId, `${owner.source_kind}:${owner.record_id}`, owner.revision,
          owner.conversation_session_id, owner.observed_at, owner.observed_at,
          owner.project_id, owner.source_kind, owner.content_hash, now, now);
      db.query("INSERT OR IGNORE INTO entities(id,type,label_original,properties,identity_scope,project_id,created_at) VALUES(?,'episode',?,'{}','user',NULL,?)")
        .run(episodeId, episodeId, now);
      const refs: string[] = [];
      for (const span of splitUtf8Spans(owner.text, MAX_WINDOW_BYTES)) {
        const sourceId = projectionHash(["memory-source", episodeId, owner.revision, owner.source_kind, owner.record_id, span.start, span.end, owner.content_hash]);
        db.query(`INSERT OR IGNORE INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis)
          VALUES(?,?,?,?,?,?,?,'/text',?,?,?,?,?,?,?)`).run(
          sourceId, episodeId, owner.revision, owner.source_kind, owner.conversation_session_id,
          owner.conversation_message_id, owner.record_id, span.start, span.end, owner.content_hash, owner.role,
          "unknown", owner.observed_at, owner.basis,
        );
        refs.push(sourceId);
      }
      const complete = { state: "complete", completed_units: refs.length, total_units: refs.length };
      const pending = { state: "pending", blocked_by: null };
      const existing = db.query<{ value: number }, [string]>("SELECT 1 value FROM memory_projection_jobs WHERE job_id=?").get(jobId);
      db.query(`INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(episode_id,revision,extraction_version) DO UPDATE SET observed_completion_job_ids=excluded.observed_completion_job_ids`)
        .run(jobId, episodeId, owner.revision, MEMORY_EXTRACTION_VERSION, generation.generationId,
          model.effective_model, model.reasoning_effort, JSON.stringify(input.completionJobId ? [input.completionJobId] : []),
          JSON.stringify(complete), JSON.stringify(pending), JSON.stringify(pending), JSON.stringify(pending), JSON.stringify(pending), now);
      if (!existing) packWindows(refs, db, MAX_WINDOW_BYTES).forEach((windowRefs, index) =>
        db.query("INSERT INTO memory_projection_windows(window_ref,job_id,ordinal,source_refs_json,state) VALUES(?,?,?,?,?)")
          .run(projectionHash(["memory-window", owner.revision, ...windowRefs]), jobId, index, JSON.stringify(windowRefs), "pending"));
      refreshSemanticState(db, jobId);
    })());
    const vectorText = episodeProjectionTextForJob(generation.sourceRoot, db, jobId);
    await withMemoryWriteGateAsync(input.context, () => {
      assertJobRevisionCurrent(generation.sourceRoot, db, jobId);
      refreshVectorUnitsForJob(db, jobId, vectorText);
    });
    return progressFromDb(db, jobId);
  } finally { db.close(); }
}

async function consumeTypedMemoryLifecycle(
  context: MemoryExecutionContext,
  generation: MemoryGenerationHandle,
  source: Extract<MemorySourceNotice, { kind: "explicit_record" | "task_report" }>,
  disposition: "forgotten" | "superseded",
): Promise<MemoryJobProgress> {
  const episodeId = projectionHash(["typed-memory-record", source.kind, source.record_id]);
  const jobId = projectionHash([
    "memory-lifecycle", episodeId, source.revision, source.operation_id,
  ]);
  const db = openProjectionDb(generation.graphPath);
  try {
    await withMemoryWriteGateAsync(context, () => db.transaction(() => {
      const currentLifecycle = source.kind === "explicit_record"
        ? readExplicitMemoryLifecycle({
          butlerData: generation.sourceRoot,
          recordId: source.record_id,
          operationId: source.operation_id,
          revision: source.revision,
        }, { unavailable: "throw" })
        : readTaskMemoryNoticeLifecycle({
          butlerData: generation.sourceRoot,
          recordId: source.record_id,
          operationId: source.operation_id,
          revision: source.revision,
        }, { unavailable: "throw" });
      if (currentLifecycle !== disposition) throw new Error("memory_source_changed");
      if (disposition === "forgotten") {
        db.query(
          "UPDATE memory_chunks SET current_revision=?,status='forgotten',updated_at=? WHERE source_key=?",
        ).run(source.revision, new Date().toISOString(), `${source.kind}:${source.record_id}`);
      }
      if (disposition === "superseded") {
        db.query(
          "UPDATE memory_chunks SET status='superseded',updated_at=? WHERE source_key=? AND current_revision=?",
        ).run(new Date().toISOString(), `${source.kind}:${source.record_id}`, source.revision);
      }
      db.query("INSERT OR REPLACE INTO memory_state(key,value) VALUES(?,?)").run(
        `typed_lifecycle:${source.operation_id}`,
        JSON.stringify({
          disposition,
          source_kind: source.kind,
          record_id: source.record_id,
          revision: source.revision,
        }),
      );
    })());
  } finally {
    db.close();
  }
  const complete = { state: "complete" as const, completed_units: 0, total_units: 0 };
  return {
    job_id: jobId,
    observed_completion_job_ids: [],
    episode_id: episodeId,
    revision: source.revision,
    extraction_version: MEMORY_EXTRACTION_VERSION,
    generation: generation.generationId,
    source: complete,
    semantic_graph: complete,
    episode_vectors: complete,
    node_vectors: complete,
    hot_cache: complete,
    outcome: "superseded",
  };
}

export async function advanceNextMemoryProjection(input: {
  context: MemoryExecutionContext;
}): Promise<MemoryJobProgress | null> {
  const generation = resolveMemoryGeneration(input.context);
  const sourceRoot = generation.sourceRoot;
  const db = openProjectionDb(generation.graphPath);
  await withMemoryWriteGateAsync(input.context, () => {
    ensureV2MemorySchema(db);
    installAndBackfillRecallIndexes(db);
  });
  const backfill = prepareVectorUnitBackfill(sourceRoot, db);
  if (backfill.length) await withMemoryWriteGateAsync(input.context, () => {
    for (const prepared of backfill) {
      assertJobRevisionCurrent(sourceRoot, db, prepared.jobId);
      refreshVectorUnitsForJob(db, prepared.jobId, prepared.text);
    }
  });
  const selected = await withMemoryWriteGateAsync(input.context, () => selectNextProjectionJob(db, undefined,
    (jobId, windowRef, ownerNonce) => activeProjectionOperations.has(
      projectionOperationKey(input.context.butlerData, generation.generationId, jobId, windowRef, ownerNonce)),
    (jobId, unitId, ownerNonce) => activeVectorOperations.has(
      vectorOperationKey(input.context.butlerData, generation.generationId, jobId, unitId, ownerNonce))));
  if (!selected) { db.close(); return null; }
  if (selected.stage === "hot_cache") {
    try {
      await withMemoryWriteGateAsync(input.context, () => advanceHotCacheQuantum(input.context, generation, db, selected.jobId));
      return progressFromDb(db, selected.jobId);
    } finally { db.close(); }
  }
  if (selected.stage === "node_vectors" || selected.stage === "episode_vectors") {
    const units = await withMemoryWriteGateAsync(input.context, () => claimNextVectorQuantum(db, {
      jobId: selected.jobId,
      kind: selected.stage === "node_vectors" ? "node" : "episode",
      isOwnerActive: (jobId, unitId, ownerNonce) => activeVectorOperations.has(
        vectorOperationKey(input.context.butlerData, generation.generationId, jobId, unitId, ownerNonce)),
    }));
    if (units.length === 0) { const progress = progressFromDb(db, selected.jobId); db.close(); return progress; }
    const operationKeys = units.map((unit) => vectorOperationKey(
      input.context.butlerData, generation.generationId, unit.job_id, unit.unit_id, unit.owner_nonce!,
    ));
    for (const key of operationKeys) activeVectorOperations.add(key);
    try {
      if (generation.embedding) {
        const persisted = await findPersistedVectorReceipt(generation, units, generation.embedding.version);
        if (persisted) {
          await withMemoryWriteGateAsync(input.context, () => {
            for (const unit of units) assertJobRevisionCurrent(sourceRoot, db, unit.job_id);
            completeVectorQuantum(db, units, persisted);
          });
          return progressFromDb(db, units[0]!.job_id);
        }
        const reusedRows = await prepareReusedGenerationVectorRows(generation, units, generation.embedding.version);
        if (reusedRows) {
          await withMemoryWriteGateAsync(input.context, async () => {
            for (const unit of units) assertJobRevisionCurrent(sourceRoot, db, unit.job_id);
            const current = resolveMemoryGeneration(input.context);
            if (!current.embedding || current.embedding.version !== generation.embedding?.version) throw new Error("memory_embedding_version_mismatch");
            const embeddingVersion = current.embedding.version;
            await writeGenerationVectorRows(current, reusedRows);
            for (const unit of units) assertJobRevisionCurrent(sourceRoot, db, unit.job_id);
            completeVectorQuantum(db, units, {
              generation: current.generationId,
              embedding_version: embeddingVersion,
              vector_keys: reusedRows.map((row) => row.vector_key).sort(),
              row_count: reusedRows.length,
              inference_reused: true,
            });
          });
          return progressFromDb(db, units[0]!.job_id);
        }
      }
      await withMemoryWriteGateAsync(input.context, () => recordVectorInvocationStarted(db, units));
      const embedded = await embedVectorQuantum({
        generation,
        units,
        expected: generation.embedding ?? undefined,
        signal: input.context.signal,
        deadlineAt: Math.min(input.context.deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + 30_000),
      });
      await withMemoryWriteGateAsync(input.context, async () => {
        for (const unit of units) assertJobRevisionCurrent(sourceRoot, db, unit.job_id);
        const pinned = bindObservedGenerationEmbeddingUnderWriteGate(input.context, embedded.metadata);
        const current = resolveMemoryGeneration(input.context);
        if (pinned.version !== embedded.metadata.version || current.embedding?.version !== pinned.version)
          throw new Error("memory_embedding_version_mismatch");
        await writeGenerationVectorRows(current, embedded.rows);
        for (const unit of units) assertJobRevisionCurrent(sourceRoot, db, unit.job_id);
        const receivedGeneration = resolveMemoryGeneration(input.context);
        if (receivedGeneration.generationId !== current.generationId || receivedGeneration.embedding?.version !== pinned.version)
          throw new Error("memory_generation_changed");
        completeVectorQuantum(db, units, {
          generation: receivedGeneration.generationId,
          embedding_version: pinned.version,
          vector_keys: embedded.rows.map((row) => row.vector_key).sort(),
          row_count: embedded.rows.length,
        });
      });
      return progressFromDb(db, units[0]!.job_id);
    } catch (error) {
      if (isCommitInterruption(error)) return progressFromDb(db, units[0]!.job_id);
      const failure = retryDecision(error, units[0]!.attempt_count);
      await withMemoryWriteGateAsync(input.context, () => failVectorQuantum(db, units, vectorFailureCode(error), failure.retryAt));
      return progressFromDb(db, units[0]!.job_id);
    } finally { for (const key of operationKeys) activeVectorOperations.delete(key); db.close(); }
  }
  const pending = await withMemoryWriteGateAsync(input.context, () => claimNextProjectionWindow(db, {
    jobId: selected.jobId,
    isOwnerActive: (jobId, windowRef, ownerNonce) => activeProjectionOperations.has(
      projectionOperationKey(input.context.butlerData, generation.generationId, jobId, windowRef, ownerNonce),
    ),
  }));
  if (!pending) { const progress = progressFromDb(db, selected.jobId); db.close(); return progress; }
  const operationKey = projectionOperationKey(input.context.butlerData, generation.generationId, pending.job_id, pending.window_ref, pending.ownerNonce);
  activeProjectionOperations.add(operationKey);
  try {
    let extractInput: ExtractInput;
    try {
      extractInput = (pending.pinnedInput as ExtractInput | null) ?? await buildExtractInput(
        input.context, db, pending.job_id, pending.window_ref, pending.sourceRefs,
      );
      if (!pending.pinnedInput) await withMemoryWriteGateAsync(input.context, () => pinWindowInput(
        db, pending.window_ref, pending.ownerNonce, extractInput,
        pending.attemptCount > 1 ? "legacy_input_unavailable" : null,
      ));
      assertProjectionSourceCurrent(sourceRoot, db, extractInput);
    } catch (error) {
      if (isCommitInterruption(error)) return progressFromDb(db, pending.job_id);
      await handleProjectionFailure(input.context, generation, db, pending, error, { providerInvoked: false, preserveResult: false });
      return progressFromDb(db, pending.job_id);
    }
    if (pending.previousState === "planned" || pending.output) {
      if (!pending.output)
        throw new Error("memory_projection_plan_missing");
      let durablePlan = pending.plan as NormalizedPlan | null;
      if (!durablePlan) {
        durablePlan = await validateAndPersistProjectionPlan(
          input.context, sourceRoot, db, pending, extractInput, pending.output, false,
        );
        if (!durablePlan) return progressFromDb(db, pending.job_id);
      }
      try {
        await withMemoryWriteGateAsync(input.context, () => db.transaction(() => {
          assertProjectionSourceCurrent(sourceRoot, db, extractInput);
          const candidateResolutions = assertPlanCandidatesCurrent(db, sourceRoot, extractInput, durablePlan!);
          applyPlan(db, pending.job_id, pending.window_ref, extractInput, pending.output!, durablePlan!, candidateResolutions, sourceRoot);
          installAndBackfillRecallIndexes(db);
        })());
      } catch (error) {
        if (isCommitInterruption(error)) return progressFromDb(db, pending.job_id);
        await withMemoryWriteGateAsync(input.context, () => {
          if (error instanceof Error && error.message === "memory_extract_candidate_changed")
            invalidatePlannedWindow(db, pending.job_id, pending.window_ref, pending.ownerNonce, error.message);
          else {
            const failure = retryDecision(error, pending.recoveryAttemptCount);
            markPlannedWindowFailure(db, pending.job_id, pending.window_ref, pending.ownerNonce, safeProjectionError(error), failure.retryAt);
          }
        });
        return progressFromDb(db, pending.job_id);
      }
      try {
        const vectorText = episodeProjectionTextForJob(sourceRoot, db, pending.job_id);
        await withMemoryWriteGateAsync(input.context, () => {
          assertJobRevisionCurrent(sourceRoot, db, pending.job_id);
          refreshVectorUnitsForJob(db, pending.job_id, vectorText);
        });
      } catch (error) {
        if (isCommitInterruption(error)) return progressFromDb(db, pending.job_id);
        await withMemoryWriteGateAsync(input.context, () =>
          markVectorRegistrationFailure(db, pending.job_id, safeProjectionError(error), vectorRegistrationFailureStage(error) ?? "episode"));
      }
      return progressFromDb(db, pending.job_id);
    }
    const timeout = new AbortController();
    const timeoutReason = {};
    const timer = setTimeout(() => timeout.abort(timeoutReason), 180_000);
    const signal = AbortSignal.any([input.context.signal, timeout.signal]);
    let output: ExtractOutput;
    let providerEvidence: unknown;
    let validatedPlanSaved = false;
    let providerResultSaved = false;
    let planApplied = false;
    let failureEvidence: unknown;
    let failureCode: string | undefined;
    let requestWire: Record<string, string | number> | undefined;
    let providerInvocationIntended = false;
    let providerInvoked = false;
    const started = performance.now();
    const stream = observeExtractionStream(started);
    try {
      let extraction: Awaited<ReturnType<typeof runStructuredMemoryExtractor>>;
      try {
        extraction = await runStructuredMemoryExtractor({
          butlerData: sourceRoot,
          extractInput,
          model: pending.model,
          reasoningEffort: pending.reasoningEffort,
          signal,
          onProviderStreamEvent: stream.observe,
          onRequestPrepared: (evidence) => { requestWire = evidence; },
          onProviderInvocationIntent: async () => {
            await withMemoryWriteGateAsync(input.context, () => {
              assertProjectionSourceCurrent(sourceRoot, db, extractInput);
              recordProviderInvocationIntent(db, pending.window_ref, pending.ownerNonce);
            });
            providerInvocationIntended = true;
          },
          onProviderAdapterEntry: () => { providerInvoked = true; },
        });
      } catch (error) {
        if (!(error instanceof MemoryExtractAttemptError)) {
          const origin = signal.aborted ? (signal.reason === timeoutReason ? "local" : "external")
            : error instanceof ModelProviderRequestError && error.timeoutKind ? "provider" : "unknown";
          failureCode = origin === "local" ? "memory_extract_timeout"
            : origin === "external" ? "memory_extract_cancelled" : undefined;
          failureEvidence = {
            ...extractionFailureEvidence(error, pending.model, origin, performance.now() - started, failureCode),
            visible_stream: stream.settle(),
            ...(requestWire ? { request_wire: requestWire } : {}),
          };
          if (failureCode) throw new Error(failureCode, { cause: error });
        }
        throw error;
      } finally {
        clearTimeout(timer);
        stream.settle();
      }
      output = extraction.output;
      providerEvidence = { ...extraction.evidence, visible_stream: stream.settle() };
      await withMemoryWriteGateAsync(input.context, () => db.transaction(() => {
        assertProjectionSourceCurrent(sourceRoot, db, extractInput);
        saveAttemptResult(db, pending.window_ref, pending.ownerNonce, output, providerEvidence);
      })());
      providerResultSaved = true;
      const plan = await validateAndPersistProjectionPlan(
        input.context, sourceRoot, db, pending, extractInput, output, true, providerEvidence,
      );
      if (!plan) return progressFromDb(db, pending.job_id);
      validatedPlanSaved = true;
      resolveMemoryGeneration(input.context);
      await withMemoryWriteGateAsync(input.context, () => db.transaction(() => {
        assertProjectionSourceCurrent(
          sourceRoot,
          db,
          extractInput,
        );
        const candidateResolutions = assertPlanCandidatesCurrent(db, sourceRoot, extractInput, plan);
        applyPlan(
          db,
          pending.job_id,
          pending.window_ref,
          extractInput,
          output,
          plan,
          candidateResolutions,
          sourceRoot,
        );
        installAndBackfillRecallIndexes(db);
      })());
      planApplied = true;
      try {
        const vectorText = episodeProjectionTextForJob(sourceRoot, db, pending.job_id);
        await withMemoryWriteGateAsync(input.context, () => {
          assertJobRevisionCurrent(sourceRoot, db, pending.job_id);
          refreshVectorUnitsForJob(db, pending.job_id, vectorText);
        });
      } catch (error) {
        if (isCommitInterruption(error)) return progressFromDb(db, pending.job_id);
        await withMemoryWriteGateAsync(input.context, () =>
          markVectorRegistrationFailure(db, pending.job_id, safeProjectionError(error), vectorRegistrationFailureStage(error) ?? "episode"));
      }
      return progressFromDb(db, pending.job_id);
    } catch (error) {
      if (isCommitInterruption(error)) return progressFromDb(db, pending.job_id);
      if (error instanceof MemoryExtractAttemptError) {
        const failure = retryDecision(error, pending.recoveryAttemptCount + 1);
        await withMemoryWriteGateAsync(input.context, () => db.transaction(() => {
          saveAttemptResult(db, pending.window_ref, pending.ownerNonce, error.output, {
            ...(error.providerEvidence as Record<string, unknown>), visible_stream: stream.settle(),
          });
          markWindowFailure(db, pending.job_id, pending.window_ref, safeProjectionError(error), {
            retryAt: failure.retryAt,
            ownerNonce: pending.ownerNonce,
            attemptKind: "provider",
            providerInvoked: true,
            clearResult: true,
            failureEvidence: error.providerEvidence,
          });
        })());
        return progressFromDb(db, pending.job_id);
      }
      if (planApplied) {
        await withMemoryWriteGateAsync(input.context, () => markVectorRegistrationFailure(db, pending.job_id, safeProjectionError(error), vectorRegistrationFailureStage(error) ?? "episode"));
      } else if (validatedPlanSaved) await withMemoryWriteGateAsync(input.context, () => {
        if (error instanceof Error && error.message === "memory_extract_candidate_changed")
          invalidatePlannedWindow(db, pending.job_id, pending.window_ref, pending.ownerNonce, error.message);
        else {
          const failure = retryDecision(error, pending.recoveryAttemptCount);
          markPlannedWindowFailure(db, pending.job_id, pending.window_ref, pending.ownerNonce, safeProjectionError(error), failure.retryAt);
        }
      });
      else await handleProjectionFailure(input.context, generation, db, pending, error, {
        providerInvoked,
        preserveResult: providerResultSaved,
        failureEvidence: {
          ...(failureEvidence && typeof failureEvidence === "object" ? failureEvidence as Record<string, unknown> : {}),
          invocation_intended: providerInvocationIntended,
          adapter_entered: providerInvoked,
        },
        failureCode,
      });
      return progressFromDb(db, pending.job_id);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    activeProjectionOperations.delete(operationKey);
    db.close();
  }
}

export function resolveMemorySource(input: {
  context: MemoryExecutionContext;
  sourceRef: string;
  maxChars?: number;
  authorize?: (source: {
    source_id: string;
    conversation_session_id: string | null;
    origin_kind: string;
    source_kind?: string;
    project_id?: string | null;
  }) => boolean;
}): ResolvedMemorySource {
  if (input.sourceRef.startsWith("conversation-source:v2:")) {
    return resolveCanonicalConversationSource(input);
  }
  const generation = resolveMemoryGeneration(input.context);
  const sourceRef = decodePublicMemorySourceRef(
    input.sourceRef,
    generation.generationId,
  );
  const db = openProjectionDb(generation.graphPath, true);
  try {
    const row = sourceRows(db, [sourceRef])[0];
    if (!row) throw new Error("memory_source_not_found");
    const projectId = db.query<{ project_id: string | null }, [string]>(
      "SELECT project_id FROM memory_chunks WHERE memory_chunk_id=?",
    ).get(row.episode_id)?.project_id ?? null;
    if (input.authorize && !input.authorize({ ...row, project_id: projectId })) {
      throw new Error("invalid_scope");
    }
    return hydrateSource(generation.sourceRoot, row, input.maxChars);
  } finally {
    db.close();
  }
}

function resolveCanonicalConversationSource(input: {
  context: MemoryExecutionContext;
  sourceRef: string;
  maxChars?: number;
  authorize?: (
    source: {
      source_id: string;
      conversation_session_id: string | null;
      origin_kind: string;
      source_kind?: string;
      project_id?: string | null;
    },
  ) => boolean;
}): ResolvedMemorySource {
  const parts = input.sourceRef.split(":");
  if (parts.length !== 6 || !/^[a-f0-9]{64}$/u.test(parts[5]!)) {
    throw new Error("memory_source_not_found");
  }
  const decode = (value: string) =>
    Buffer.from(value, "base64url").toString("utf8");
  const messageId = decode(parts[2]!);
  const partId = decode(parts[3]!);
  const pointer = decode(parts[4]!);
  const reader = createLazyConversationProjectionReader({
    butlerData: input.context.butlerData,
  });
  try {
    const message = reader.readMessageById(messageId);
    if (!message) throw new Error("memory_source_not_found");
    const candidate = {
      source_id: input.sourceRef,
      conversation_session_id: message.session_id,
      origin_kind: message.origin_kind ?? "unknown",
    };
    if (input.authorize && !input.authorize(candidate)) {
      throw new Error("invalid_scope");
    }
    const scalar = decodeMessageScalars(message).find((item) =>
      item.part.id === partId && item.pointer === pointer,
    );
    if (!scalar) throw new Error("memory_source_not_found");
    if (scalar.hash !== parts[5]) throw new Error("memory_source_changed");
    const excerpt = input.maxChars
      ? [...scalar.text].slice(0, input.maxChars).join("")
      : scalar.text;
    return {
      source_ref: input.sourceRef,
      source_kind: "conversation",
      text: scalar.text,
      scalar_text: scalar.text,
      excerpt,
      byte_start: 0,
      byte_end: Buffer.byteLength(scalar.text, "utf8"),
      source_hash: scalar.hash,
      conversation_session_id: message.session_id,
      conversation_message_id: message.id,
      basis: message.role === "user" ? "user_statement" : "assistant_statement",
      origin_kind: candidate.origin_kind as ResolvedMemorySource["origin_kind"],
    };
  } finally {
    reader.close();
  }
}

function decodePublicMemorySourceRef(
  value: string,
  generationId: string,
): string {
  if (!value.startsWith("memory-source:v2:")) return value;
  const parts = value.split(":");
  if (parts.length !== 4) throw new Error("memory_source_not_found");
  const referencedGeneration = Buffer.from(parts[2]!, "base64url").toString(
    "utf8",
  );
  if (referencedGeneration !== generationId) {
    throw new Error("memory_source_changed");
  }
  return Buffer.from(parts[3]!, "base64url").toString("utf8");
}

export function completionProjectionProcessed(input: {
  butlerData: string;
  completionJobId: string;
}): boolean {
  try {
    const descriptor = readActiveDescriptor(input.butlerData);
    const generation = resolveMemoryGeneration({
      butlerData: input.butlerData,
      target: {
        kind: "active",
        expected_generation: descriptor.generation_id,
      },
      signal: new AbortController().signal,
    });
    const db = openProjectionDb(generation.graphPath, true);
    try {
      const rows = db
        .query<
          {
            episode_id: string;
            revision: string;
            observed_completion_job_ids: string;
            source_state: string;
            semantic_graph_state: string;
            episode_vectors_state: string;
            node_vectors_state: string;
            hot_cache_state: string;
          },
          []
        >("SELECT * FROM memory_projection_jobs")
        .all();
      return rows.some((row) => {
        const observed = JSON.parse(row.observed_completion_job_ids) as unknown;
        const stages = [
          row.source_state,
          row.semantic_graph_state,
          row.episode_vectors_state,
          row.node_vectors_state,
          row.hot_cache_state,
        ].map((value) => JSON.parse(value) as { state?: string });
        if (
          !Array.isArray(observed) ||
          !observed.includes(input.completionJobId) ||
          !stages.every((stage) => stage.state === "complete")
        ) {
          return false;
        }
        const sourceRefs = sourceRowsForEpisode(db, row.episode_id, row.revision);
        if (sourceRefs.length === 0) return false;
        const extractInput: ExtractInput = {
          schema: "butler.memory-extract-input.v2",
          episode_ref: row.episode_id,
          revision: row.revision,
          window_ref: "completion-status",
          bound_project_id: null,
          source_units: sourceRefs.map((source) => ({
            ref: source.source_id,
            text: hydrateSource(input.butlerData, source).text,
            role: source.role,
            observed_at: source.observed_at,
            origin_kind: source.origin_kind as ExtractInput["source_units"][number]["origin_kind"],
          })),
          context_units: [],
          candidates: [],
        };
        assertProjectionSourceCurrent(input.butlerData, db, extractInput);
        return true;
      });
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function sourceRowsForEpisode(
  db: ReturnType<typeof openProjectionDb>,
  episodeId: string,
  revision: string,
) {
  return db
    .query<ProjectionSourceRow, [string, string]>(
      "SELECT * FROM memory_chunk_sources WHERE episode_id=? AND revision=? ORDER BY source_id",
    )
    .all(episodeId, revision);
}

async function buildExtractInput(
  context: MemoryExecutionContext,
  db: ReturnType<typeof openProjectionDb>,
  jobId: string,
  windowRef: string,
  refs: string[],
): Promise<ExtractInput> {
  const generation = resolveMemoryGeneration(context);
  const butlerData = generation.sourceRoot;
  const rows = sourceRows(db, refs);
  if (rows.length !== refs.length) throw new Error("memory_source_changed");
  const chunk = db
    .query<
      {
        memory_chunk_id: string;
        current_revision: string;
        project_id: string | null;
        conversation_session_id: string | null;
        conversation_turn_id: string | null;
      },
      [string]
    >(
      "SELECT c.memory_chunk_id,c.current_revision,c.project_id,c.conversation_session_id,c.conversation_turn_id FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id WHERE j.job_id=?",
    )
    .get(jobId);
  if (!chunk || rows.some((row) => row.revision !== chunk.current_revision))
    throw new Error("memory_source_changed");
  const source_units = refs.map((ref) => {
    const row = rows.find((item) => item.source_id === ref)!;
    const hydrated = hydrateSource(butlerData, row);
    return {
      ref,
      text: hydrated.text,
      role: row.role,
      observed_at: row.observed_at,
      origin_kind:
        row.origin_kind as ExtractInput["source_units"][number]["origin_kind"],
    };
  });
  if (
    source_units.some(
      (unit) =>
        (unit.role === "user" && unit.origin_kind !== "user_input") ||
        (unit.role === "assistant" &&
          unit.origin_kind !== "assistant_public") ||
        (unit.role === "task" && rows.find((row) => row.source_id === unit.ref)?.source_kind !== "task_report") ||
        (unit.role === "explicit" && rows.find((row) => row.source_id === unit.ref)?.source_kind !== "explicit_record"),
    )
  ) {
    throw new Error("memory_source_ineligible");
  }
  const candidates = await buildSourceWindowCandidates({
    context,
    butlerData,
    db,
    chunk,
    sessionId: rows[0]?.conversation_session_id ?? "",
    turnId: chunk.conversation_turn_id ?? "",
    operationId: windowRef,
    sourceUnits: source_units,
  });
  const context_units = rows[0]?.conversation_session_id
    ? readPriorPublicContext(butlerData, rows[0].conversation_session_id, source_units)
    : [];
  const previous = db.query<{ source_refs_json: string }, [string, string]>(`
    SELECT source_refs_json FROM memory_projection_windows WHERE job_id=? AND state!='replaced' AND ordinal<
      (SELECT ordinal FROM memory_projection_windows WHERE window_ref=?) ORDER BY ordinal DESC LIMIT 1
  `).get(jobId, windowRef);
  if (previous) {
    const previousRefs = JSON.parse(previous.source_refs_json) as string[];
    const previousRow = sourceRows(db, previousRefs).sort((a, b) => previousRefs.indexOf(a.source_id) - previousRefs.indexOf(b.source_id)).at(-1);
    if (previousRow) {
      const hydrated = hydrateSource(butlerData, previousRow);
      context_units.push({ ref: previousRow.source_id, text: hydrated.text, observed_at: previousRow.observed_at, basis: previousRow.basis as ExtractInput["context_units"][number]["basis"] });
    }
  }
  const extractInput: ExtractInput = {
    schema: "butler.memory-extract-input.v2",
    episode_ref: chunk.memory_chunk_id,
    revision: chunk.current_revision,
    window_ref: windowRef,
    bound_project_id: chunk.project_id,
    source_units,
    context_units,
    candidates,
  };
  return enforceExtractInputBudget(extractInput);
}

async function buildSourceWindowCandidates(input: {
  context: MemoryExecutionContext;
  butlerData: string;
  db: ReturnType<typeof openProjectionDb>;
  chunk: { memory_chunk_id: string; current_revision: string; project_id: string | null };
  sessionId: string;
  turnId: string;
  operationId: string;
  sourceUnits: ExtractInput["source_units"];
}): Promise<ExtractInput["candidates"]> {
  const cue = input.sourceUnits.map((unit) => unit.text).join("\n");
  if (Buffer.byteLength(cue) > MAX_CANDIDATE_BYTES) throw new Error("memory_extract_source_window_exceeds_budget");
  const asOf = input.sourceUnits.reduce((latest, unit) => unit.observed_at > latest ? unit.observed_at : latest, input.sourceUnits[0]?.observed_at ?? new Date().toISOString());
  const recallInput = {
    context: input.context,
    cue,
    includeVector: false,
    includeInternal: false,
    limit: 20,
    scope: "all_user_sessions" as const,
    projectFilter: "any" as const,
    projectIds: [],
    sessionIds: [],
    asOf,
    runtime: { sessionId: input.sessionId, turnId: input.turnId, currentUserMessage: cue, nativeOperationId: input.operationId, projectId: input.chunk.project_id },
  };
  let vectorNodes: Awaited<ReturnType<typeof searchGenerationVectors>>["nodes"] = [];
  const generation = resolveMemoryGeneration(input.context);
  if (generation.embedding) {
    try {
      const matches = await searchGenerationVectors({
        generation,
        phrases: [cue],
        scope: recallInput.scope,
        projectFilter: recallInput.projectFilter,
        projectIds: recallInput.projectIds,
        runtimeProjectId: input.chunk.project_id,
        runtimeSessionId: input.sessionId,
        sessionIds: [],
        asOf,
        includeInternal: false,
        sourceProjectId: input.chunk.project_id,
        deadlineAt: Date.now() + 5_000,
      });
      vectorNodes = filterCurrentGenerationVectorMatches(input.db, generation, matches, {
        scope: recallInput.scope,
        projectFilter: recallInput.projectFilter,
        projectIds: recallInput.projectIds,
        runtimeProjectId: input.chunk.project_id,
        runtimeSessionId: input.sessionId,
        sessionIds: [],
        asOf,
        sourceProjectId: input.chunk.project_id,
        includeInternal: false,
      }).nodes;
    } catch {
      vectorNodes = [];
    }
  }
  const bound = input.db.query<{ entity_id: string }, [string, string]>(`
    SELECT DISTINCT entity_id FROM entity_mentions WHERE episode_id=? AND revision=? ORDER BY entity_id LIMIT 8
  `).all(input.chunk.memory_chunk_id, input.chunk.current_revision).map((row) => row.entity_id);
  const semantic = selectSemanticSeeds(input.db, recallInput, vectorNodes, Date.now() + 5_000, 32, { projectId: input.chunk.project_id }).allSeeds;
  const ids = [...new Set([...bound, ...semantic])].slice(0, 32);
  return loadSourceWindowCandidates({ db: input.db, butlerData: input.butlerData, projectId: input.chunk.project_id, ids });
}

function loadSourceWindowCandidates(input: {
  db: ReturnType<typeof openProjectionDb>;
  butlerData: string;
  projectId: string | null;
  ids: string[];
  candidateBytes?: number;
}): ExtractInput["candidates"] {
  return packExtractionCandidates(input.ids, (id) => {
    const node = input.db.query<{ id: string; type: string; identity_scope: "user" | "project"; project_id: string | null; properties: string }, [string]>("SELECT id,type,identity_scope,project_id,properties FROM entities WHERE id=?").get(id);
    if (!node) return null;
    const identityNode = node.type === "entity" || node.type === "project";
    if (!identityNode && (input.projectId === null
      ? node.identity_scope !== "user" || node.project_id !== null
      : node.identity_scope !== "project" || node.project_id !== input.projectId)) return null;
    const aliases = input.db.query<{ surface_original: string; source_id: string }, any>(`
      SELECT DISTINCT a.surface_original,a.source_id FROM entity_aliases a
      JOIN memory_chunk_sources s ON s.source_id=a.source_id JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
      WHERE a.entity_id=? AND s.origin_kind IN ('user_input','assistant_public') AND (c.project_id IS NULL OR c.project_id IS ?)
      ORDER BY a.surface_original,a.source_id LIMIT 3
    `).all(id, input.projectId);
    if (!aliases.length) return null;
    const evidence = aliases.slice(0, 2).map((alias) => {
      const source = sourceRows(input.db, [alias.source_id])[0]!;
      const resolved = hydrateSource(input.butlerData, source, 160);
      return { ref: source.source_id, text: resolved.excerpt, observed_at: source.observed_at, basis: source.basis as ExtractInput["candidates"][number]["evidence"][number]["basis"] };
    });
    let claim: ExtractInput["candidates"][number]["claim"] = null;
    if (!identityNode) {
      const properties = JSON.parse(node.properties) as {
        polarity?: "positive" | "negative" | "unspecified";
        condition?: string | null;
      };
      const endpoints = input.db.query<{ rel_type: string; target_node_id: string }, [string]>(
        "SELECT rel_type,target_node_id FROM edges WHERE source_node_id=? AND rel_type IN ('has_subject','has_object') ORDER BY edge_id",
      ).all(node.id);
      const relation = input.db.query<{ rel_type: NonNullable<ExtractInput["candidates"][number]["claim"]>["relation"] }, [string]>(
        "SELECT rel_type FROM edges WHERE claim_node_id=? AND rel_type NOT IN ('has_subject','has_object','supersedes','contradicts') ORDER BY edge_id LIMIT 1",
      ).get(node.id)?.rel_type ?? null;
      claim = {
        subject_ref: endpoints.find((edge) => edge.rel_type === "has_subject")?.target_node_id ?? null,
        object_ref: endpoints.find((edge) => edge.rel_type === "has_object")?.target_node_id ?? null,
        relation,
        polarity: properties.polarity ?? null,
        condition: properties.condition ?? null,
      };
    }
    const label = aliases[0]!.surface_original;
    return {
      ref: node.id,
      type: node.type as ExtractInput["candidates"][number]["type"],
      label,
      aliases: [...new Set(aliases.map((alias) => alias.surface_original))]
        .filter((alias) => identityNode || alias !== label),
      scope: node.identity_scope,
      project_id: node.project_id,
      claim,
      evidence,
    };
  }, input.candidateBytes);
}

function assertProjectionSourceCurrent(
  butlerData: string,
  db: ReturnType<typeof openProjectionDb>,
  input: ExtractInput,
): void {
  assertPlanSourceCurrent(db, input);
  for (const row of sourceRows(
    db,
    input.source_units.map((unit) => unit.ref),
  )) {
    hydrateSource(butlerData, row);
  }
  const chunk = db
    .query<
      {
        conversation_turn_id: string | null;
        conversation_session_id: string | null;
        source_key: string;
        current_revision: string;
      },
      [string]
    >(
      "SELECT conversation_turn_id,conversation_session_id,source_key,current_revision FROM memory_chunks WHERE memory_chunk_id=?",
    )
    .get(input.episode_ref);
  if (!chunk || chunk.current_revision !== input.revision) {
    throw new Error("memory_source_changed");
  }
  if (chunk.source_key.startsWith("task_report:") || chunk.source_key.startsWith("explicit_record:")) return;
  if (!chunk.conversation_session_id) throw new Error("memory_source_changed");
  const canonical = createLazyConversationProjectionReader({ butlerData });
  try {
    if (chunk.conversation_turn_id) {
      const outcome = canonical.readTurnOutcome(chunk.conversation_turn_id);
      if (!outcome) throw new Error("memory_source_changed");
      assertCanonicalRevisionCurrent({ canonical, turnId: chunk.conversation_turn_id, sessionId: chunk.conversation_session_id, outcomeGeneration: outcome.generation, expectedRevision: input.revision });
    } else {
      const messageId = chunk.source_key.startsWith("conversation_message:") ? chunk.source_key.slice("conversation_message:".length) : "";
      const message = canonical.readMessageById(messageId);
      if (!message || message.session_id !== chunk.conversation_session_id || !eligibleStandaloneMessage(message)) throw new Error("memory_source_changed");
      const scalars = decodeMessageScalars(message);
      const expectedRevision = projectionHash(["episode-revision", ...scalars.flatMap((scalar) => [scalar.message.id, scalar.part.id, scalar.pointer, scalar.hash]), recoveredMessageSourceHash(message)]);
      if (expectedRevision !== input.revision || chunk.current_revision !== input.revision) throw new Error("memory_source_changed");
    }
  } finally {
    canonical.close();
  }
}

function assertCanonicalNoticeCurrent(
  canonical: Pick<ConversationProjectionReader, "readTurn" | "readTurnOutcome" | "readMessageById">,
  notice: MemorySourceNotice,
  expectedRevision: string,
): void {
  if (notice.kind === "conversation_turn") {
    assertCanonicalRevisionCurrent({ canonical, turnId: notice.turn_id, sessionId: notice.session_id, outcomeGeneration: notice.outcome_generation, expectedRevision });
    return;
  }
  if (notice.kind !== "conversation_message") throw new Error("memory_source_changed");
  const message = canonical.readMessageById(notice.message_id);
  if (!message || message.session_id !== notice.session_id || !eligibleStandaloneMessage(message)) throw new Error("memory_source_changed");
  if (notice.source_hash !== recoveredMessageSourceHash(message)) throw new Error("memory_source_changed");
  const scalars = decodeMessageScalars(message);
  const revision = projectionHash(["episode-revision", ...scalars.flatMap((scalar) => [scalar.message.id, scalar.part.id, scalar.pointer, scalar.hash]), notice.source_hash]);
  if (revision !== expectedRevision) throw new Error("memory_source_changed");
}

function recoveredMessageSourceHash(message: ConversationMessageWithParts): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(message.parts.map((part) => [part.id, part.content_json])))
    .digest("hex");
}

function eligibleStandaloneMessage(message: ConversationMessageWithParts): boolean {
  if (message.turn_id !== null) return false;
  if (message.role === "assistant") return message.provenance === "recovered" && message.origin_kind === "assistant_public" && message.status === "complete";
  return message.role === "user" && message.origin_kind === "user_input" &&
    ["recovered", "imported"].includes(message.provenance) && ["complete", "failed", "compacted"].includes(message.status);
}

function assertCanonicalRevisionCurrent(input: {
  canonical: Pick<ConversationProjectionReader, "readTurn" | "readTurnOutcome" | "readMessageById">;
  turnId: string;
  sessionId: string;
  outcomeGeneration: number;
  expectedRevision: string;
}): void {
  const turn = input.canonical.readTurn(input.turnId);
  const outcome = input.canonical.readTurnOutcome(input.turnId);
  if (
    !turn ||
    !outcome ||
    turn.session_id !== input.sessionId ||
    outcome.generation !== input.outcomeGeneration ||
    !["complete", "failed", "aborted"].includes(turn.status)
  ) {
    throw new Error("memory_source_changed");
  }
  const messages = eligibleCanonicalMessages(
    input.canonical,
    outcome,
    "memory_source_changed",
  );
  const scalars = messages.flatMap(decodeMessageScalars);
  const revision = projectionHash([
    "episode-revision",
    ...scalars.flatMap((scalar) => [
      scalar.message.id,
      scalar.part.id,
      scalar.pointer,
      scalar.hash,
    ]),
    outcome.generation,
  ]);
  if (revision !== input.expectedRevision) {
    throw new Error("memory_source_changed");
  }
}

function eligibleCanonicalMessages(
  canonical: Pick<ConversationProjectionReader, "readMessageById">,
  outcome: NonNullable<
    ReturnType<ConversationProjectionReader["readTurnOutcome"]>
  >,
  errorCode: "memory_source_ineligible" | "memory_source_changed",
): ConversationMessageWithParts[] {
  const request = outcome.request_message_id
    ? canonical.readMessageById(outcome.request_message_id)
    : null;
  if (
    !request ||
    request.role !== "user" ||
    !["complete", "compacted"].includes(request.status) ||
    request.origin_kind !== "user_input"
  ) {
    throw new Error(errorCode);
  }
  const assistant = outcome.public_assistant_message_id
    ? canonical.readMessageById(outcome.public_assistant_message_id)
    : null;
  if (
    outcome.public_assistant_message_id &&
    (!assistant ||
      assistant.role !== "assistant" ||
      assistant.status !== "complete" ||
      assistant.origin_kind !== "assistant_public")
  ) {
    throw new Error(errorCode);
  }
  return assistant ? [request, assistant] : [request];
}

export function withMemoryWriteGate<T>(
  context: MemoryExecutionContext,
  run: () => T,
): T {
  const path = consolidationLockPath(context.butlerData);
  const lease = acquireConsolidationLock(path, {
    purpose: "projection",
  });
  if (!lease) throw new Error("memory_write_busy");
  let commit = false;
  try {
    assertMemoryGenerationMutationAuthority(context);
    const result = run();
    commit = true;
    return result;
  } finally {
    releaseConsolidationLock(path, lease, commit);
  }
}

export async function withMemoryWriteGateAsync<T>(context: MemoryExecutionContext, run: () => T | Promise<T>): Promise<T> {
  const path = consolidationLockPath(context.butlerData);
  const lease = await acquireConsolidationLockAsync(path, {
    purpose: "projection",
    waitClass: context.waitClass ?? "background",
    signal: context.signal,
    deadlineAt: context.deadlineAt,
  });
  if (!lease) throw new Error("memory_write_busy");
  let commit = false;
  try { assertMemoryGenerationMutationAuthority(context); const result = await run(); commit = true; return result; }
  finally { releaseConsolidationLock(path, lease, commit); }
}

const activeProjectionOperations = new Set<string>();
const activeVectorOperations = new Set<string>();

function projectionOperationKey(dataRoot: string, generationId: string, jobId: string, windowRef: string, ownerNonce: string): string {
  return JSON.stringify([dataRoot, generationId, jobId, windowRef, ownerNonce]);
}

function vectorOperationKey(dataRoot: string, generationId: string, jobId: string, unitId: string, ownerNonce: string): string {
  return JSON.stringify([dataRoot, generationId, jobId, unitId, ownerNonce]);
}

function isCommitInterruption(error: unknown): boolean {
  const code = error instanceof Error ? error.message : String(error);
  return code === "memory_write_busy" || code === "memory_source_changed" || code === "memory_generation_changed";
}

function episodeProjectionTextForJob(butlerData: string, db: ReturnType<typeof openProjectionDb>, jobId: string): Array<{ sourceId: string; text: string; role: string; byteStart: number }> {
  const job = db.query<{ episode_id: string; revision: string }, [string]>("SELECT episode_id,revision FROM memory_projection_jobs WHERE job_id=?").get(jobId);
  if (!job) throw new Error("memory_projection_job_not_found");
  return sourceRowsForEpisode(db, job.episode_id, job.revision)
    .map((source) => ({ sourceId: source.source_id, text: hydrateSource(butlerData, source).text, role: source.role, byteStart: source.byte_start }));
}

function prepareVectorUnitBackfill(butlerData: string, db: ReturnType<typeof openProjectionDb>): Array<{ jobId: string; text: ReturnType<typeof episodeProjectionTextForJob> }> {
  const jobs = db.query<{ job_id: string; episode_id: string; revision: string; semantic_graph_state: string }, []>(`
    SELECT j.job_id,j.episode_id,j.revision,j.semantic_graph_state FROM memory_projection_jobs j
    JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
    WHERE NOT EXISTS(SELECT 1 FROM memory_vector_units u WHERE u.job_id=j.job_id AND u.record_kind='episode') ORDER BY j.created_at,j.job_id
  `).all();
  return jobs.map((job) => ({ jobId: job.job_id, text: episodeProjectionTextForJob(butlerData, db, job.job_id) }));
}

function retryDecision(error: unknown, attempt: number): { retryAt: string | null } {
  if (attempt >= 3) return { retryAt: null };
  let retryable: boolean;
  let providerRetryAt: string | null = null;
  if (error instanceof ModelProviderRequestError) {
    retryable = error.retryable || error.timeoutKind !== undefined || error.statusCode === 429 || (error.statusCode !== undefined && error.statusCode >= 500 && error.statusCode < 600);
    providerRetryAt = validFutureIso(error.retryAt) ? error.retryAt! : null;
  } else {
    const message = error instanceof Error ? error.message : "";
    const code = message.includes("memory_write_busy") ? "memory_write_busy" : message;
    retryable = code.startsWith("memory_extract_invalid_") || [
      "memory_extract_timeout",
      "memory_extract_provider_failed",
      "memory_embedding_unavailable",
      "memory_embedding_queue_full",
      "memory_write_busy",
      "memory_vector_io_transient",
    ].includes(code);
  }
  if (!retryable) return { retryAt: null };
  const local = new Date(Date.now() + (attempt === 1 ? 30_000 : 120_000)).toISOString();
  return { retryAt: providerRetryAt && providerRetryAt > local ? providerRetryAt : local };
}

function observeExtractionStream(started: number) {
  let firstDeltaMs: number | null = null;
  let deltaEvents = 0;
  let deltaBytes = 0;
  let completed = false;
  let snapshot: Readonly<{
    observation_status: "no_visible_stream_observation" | "visible_output_observed" | "stream_completion_observed";
    first_visible_delta_ms: number | null;
    visible_delta_events: number | null;
    visible_utf8_bytes: number | null;
    completed_event_observed: boolean;
  }> | null = null;
  const observe: ProviderStreamProjectionHandler = (event) => {
    if (snapshot) return;
    if (event.type === "text_delta" && event.target === "final_candidate" && event.textDelta.length > 0) {
      firstDeltaMs ??= performance.now() - started;
      deltaEvents += 1;
      deltaBytes += Buffer.byteLength(event.textDelta);
    } else if (event.type === "completed" && event.status === "completed") {
      completed = true;
    }
  };
  return {
    observe,
    settle: () => snapshot ??= Object.freeze({
      observation_status: deltaEvents > 0 ? "visible_output_observed" : completed ? "stream_completion_observed" : "no_visible_stream_observation",
      first_visible_delta_ms: firstDeltaMs,
      visible_delta_events: deltaEvents > 0 || completed ? deltaEvents : null,
      visible_utf8_bytes: deltaEvents > 0 || completed ? deltaBytes : null,
      completed_event_observed: completed,
    }),
  };
}

function extractionFailureEvidence(
  error: unknown,
  model: string,
  timeoutOrigin: "local" | "external" | "provider" | "unknown",
  elapsedMs: number,
  code?: string,
): Record<string, unknown> {
  const identifier = (value: unknown): string | null =>
    typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(value) ? value : null;
  const provider = error instanceof ModelProviderRequestError ? error : null;
  return {
    failure_kind: "before_result",
    code: code ?? safeProjectionError(error),
    exception_name: identifier(error instanceof Error ? error.name : null),
    configured_model: model,
    timeout_origin: timeoutOrigin,
    local_elapsed_ms: elapsedMs,
    provider_code: identifier(provider?.code),
    upstream_status: provider?.statusCode ?? null,
    timeout_kind: provider?.timeoutKind ?? null,
    retry_at: provider?.retryAt && Number.isFinite(Date.parse(provider.retryAt)) ? new Date(provider.retryAt).toISOString() : null,
    reported_model: null,
    usage: null,
    remote_outcome: null,
  };
}

function validFutureIso(value: string | undefined): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now();
}

function isSplitFailure(error: unknown): boolean {
  if (error instanceof ModelProviderRequestError) {
    return ["context_length_exceeded", "input_too_large", "array_too_large"].includes(error.code);
  }
  const code = error instanceof Error ? error.message : "";
  return code === "memory_extract_input_exceeds_budget" || code === "memory_extract_source_window_exceeds_budget" || code === "memory_extract_output_exceeds_budget";
}

function hasExhaustedLocalTimeoutBudget(db: ReturnType<typeof openProjectionDb>, windowRef: string): boolean {
  const row = db.query<{
    attempt_count: number; recovery_base_attempt_count: number; recovery_revision: string | null;
    input_sha256: string | null; extraction_model: string;
  }, [string]>(`SELECT w.attempt_count,w.recovery_base_attempt_count,w.recovery_revision,w.input_sha256,j.extraction_model
    FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id
    WHERE w.window_ref=? AND w.state='failed' AND w.error_code='memory_extract_timeout'
      AND w.normalized_plan_json IS NULL AND w.output_json IS NULL AND w.input_json IS NOT NULL`).get(windowRef);
  if (!row?.input_sha256) return false;
  const attempts = db.query<{
    attempt_count: number; input_sha256: string | null; provider_invoked: number; invocation_ref: string | null;
    error_code: string | null; output_json: string | null; provider_evidence_json: string | null;
  }, [string, string | null]>(`SELECT attempt_count,input_sha256,provider_invoked,invocation_ref,error_code,output_json,provider_evidence_json
    FROM memory_projection_attempts WHERE window_ref=? AND recovery_revision IS ? AND state='failed' AND attempt_kind='provider'
      ORDER BY attempt_count`).all(windowRef, row.recovery_revision);
  if (attempts.length !== 3 || new Set(attempts.map((attempt) => attempt.invocation_ref)).size !== 3) return false;
  return attempts.every((attempt) => {
    if (attempt.input_sha256 !== row.input_sha256 ||
      attempt.provider_invoked !== 1 || !attempt.invocation_ref || attempt.output_json !== null || attempt.error_code !== "memory_extract_timeout") return false;
    let evidence: any;
    try { evidence = JSON.parse(attempt.provider_evidence_json ?? "null"); } catch { return false; }
    return evidence?.failure_kind === "before_result" && evidence.code === "memory_extract_timeout" &&
      evidence.timeout_origin === "local" && evidence.configured_model === row.extraction_model;
  });
}

// The caller owns the existing writer gate and graph transaction. A null result leaves the terminal leaf unchanged.
function splitExhaustedLocalTimeoutWindow(
  sourceRoot: string,
  db: ReturnType<typeof openProjectionDb>,
  windowRef: string,
  recoveryRevision?: string,
): string[] | null {
  const row = db.query<{
    job_id: string; input_json: string; input_sha256: string; source_refs_json: string;
    attempt_count: number; recovery_revision: string | null;
  }, [string]>("SELECT job_id,input_json,input_sha256,source_refs_json,attempt_count,recovery_revision FROM memory_projection_windows WHERE window_ref=?").get(windowRef);
  if (!row || !hasExhaustedLocalTimeoutBudget(db, windowRef)) return null;
  if (projectionHash(["extract-input", row.input_json]) !== row.input_sha256) throw new Error("memory_reprocess_input_changed");
  const pinned = JSON.parse(row.input_json) as ExtractInput;
  assertProjectionSourceCurrent(sourceRoot, db, pinned);
  const refs = JSON.parse(row.source_refs_json) as string[];
  const rows = sourceRows(db, refs).sort((a, b) => refs.indexOf(a.source_id) - refs.indexOf(b.source_id));
  const children = splitWindowSourceRows(db, sourceRoot, rows);
  if (!children) return null;
  const result = splitProjectionWindow(db, { jobId: row.job_id, windowRef, children, recoveryRevision,
    failedTimeout: { attemptCount: row.attempt_count, recoveryRevision: row.recovery_revision, inputSha256: row.input_sha256 } });
  return result;
}

function refreshProjectionVectors(context: MemoryExecutionContext, jobId: string): void {
  const generation = resolveMemoryGeneration(context);
  const db = openProjectionDb(generation.graphPath);
  try {
    const text = episodeProjectionTextForJob(generation.sourceRoot, db, jobId);
    withMemoryWriteGate(context, () => { assertJobRevisionCurrent(generation.sourceRoot, db, jobId); refreshVectorUnitsForJob(db, jobId, text); });
  } finally { db.close(); }
}

async function refreshProjectionVectorsAsync(context: MemoryExecutionContext, jobId: string): Promise<void> {
  const generation = resolveMemoryGeneration(context);
  const db = openProjectionDb(generation.graphPath);
  try {
    const text = episodeProjectionTextForJob(generation.sourceRoot, db, jobId);
    await withMemoryWriteGateAsync(context, () => { assertJobRevisionCurrent(generation.sourceRoot, db, jobId); refreshVectorUnitsForJob(db, jobId, text); });
  } finally { db.close(); }
}

function splitWindowSourceRows(
  db: ReturnType<typeof openProjectionDb>,
  butlerData: string,
  rows: ProjectionSourceRow[],
): [string[], string[]] | null {
  const best = nearestGraphemeByteMidpoint(rows.map((row) => ({
    text: hydrateSource(butlerData, row).text,
    bytes: row.byte_end - row.byte_start,
  })));
  if (!best) return null;
  const row = rows[best.partIndex]!;
  if (best.localByte === row.byte_end - row.byte_start) {
    return [rows.slice(0, best.partIndex + 1).map((item) => item.source_id), rows.slice(best.partIndex + 1).map((item) => item.source_id)];
  }
  const left = rows.slice(0, best.partIndex).map((item) => item.source_id);
  const right = rows.slice(best.partIndex + 1).map((item) => item.source_id);
  const bounds: Array<[number, number]> = [[row.byte_start, row.byte_start + best.localByte], [row.byte_start + best.localByte, row.byte_end]];
  const ids = bounds.map(([start, end]) => projectionHash(["memory-source-split", row.episode_id, row.revision, row.conversation_message_id, row.part_id, row.scalar_pointer, start, end, row.content_hash]));
  db.query(`INSERT OR IGNORE INTO memory_source_split_parents
    (source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis,child_source_ids_json,recorded_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.source_id, row.episode_id, row.revision, row.source_kind, row.conversation_session_id,
      row.conversation_message_id, row.part_id, row.scalar_pointer, row.byte_start, row.byte_end, row.content_hash, row.role, row.origin_kind,
      row.observed_at, row.basis, JSON.stringify(ids), new Date().toISOString());
  for (let index = 0; index < ids.length; index += 1) {
    const [start, end] = bounds[index]!;
    db.query(`INSERT OR IGNORE INTO memory_chunk_sources
      (source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ids[index]!, row.episode_id, row.revision, row.source_kind, row.conversation_session_id,
        row.conversation_message_id, row.part_id, row.scalar_pointer, start, end, row.content_hash, row.role, row.origin_kind, row.observed_at, row.basis);
  }
  db.query("DELETE FROM memory_chunk_sources WHERE source_id=?").run(row.source_id);
  const count = Number(db.query<{ count: number }, [string, string]>("SELECT COUNT(*) count FROM memory_chunk_sources WHERE episode_id=? AND revision=?").get(row.episode_id, row.revision)?.count ?? 0);
  db.query("UPDATE memory_projection_jobs SET source_state=? WHERE episode_id=? AND revision=?")
    .run(JSON.stringify({ state: "complete", completed_units: count, total_units: count }), row.episode_id, row.revision);
  return [[...left, ids[0]!], [ids[1]!, ...right]];
}

function invalidProjectionOutput(error: unknown): boolean {
  return error instanceof Error && /^memory_extract_invalid_/u.test(error.message);
}

async function validateAndPersistProjectionPlan(
  context: MemoryExecutionContext,
  sourceRoot: string,
  db: ReturnType<typeof openProjectionDb>,
  pending: NonNullable<ReturnType<typeof claimNextProjectionWindow>>,
  extractInput: ExtractInput,
  output: ExtractOutput,
  adapterEntered: boolean,
  providerEvidence?: unknown,
): Promise<NormalizedPlan | null> {
  let plan: NormalizedPlan;
  try {
    plan = normalizeAndValidatePlan(db, extractInput, output);
  } catch (error) {
    if (!invalidProjectionOutput(error)) throw error;
    const failure = retryDecision(error, pending.recoveryAttemptCount + (adapterEntered ? 1 : 0));
    await withMemoryWriteGateAsync(context, () => db.transaction(() => {
      assertProjectionSourceCurrent(sourceRoot, db, extractInput);
      markWindowFailure(db, pending.job_id, pending.window_ref, safeProjectionError(error), {
        retryAt: failure.retryAt,
        ownerNonce: pending.ownerNonce,
        attemptKind: "validation",
        providerInvoked: adapterEntered,
        clearResult: true,
        failureEvidence: providerEvidence ?? { invalid_saved_output: true },
      });
    })());
    return null;
  }
  await withMemoryWriteGateAsync(context, () => db.transaction(() => {
    assertProjectionSourceCurrent(sourceRoot, db, extractInput);
    saveValidatedPlan(db, pending.job_id, pending.window_ref, pending.ownerNonce, output, plan);
  })());
  return plan;
}

async function handleProjectionFailure(
  context: MemoryExecutionContext,
  generation: MemoryGenerationHandle,
  db: ReturnType<typeof openProjectionDb>,
  pending: NonNullable<ReturnType<typeof claimNextProjectionWindow>>,
  error: unknown,
  attempt: { providerInvoked: boolean; preserveResult: boolean; failureEvidence?: unknown; failureCode?: string } = { providerInvoked: true, preserveResult: false },
): Promise<void> {
  if (isSplitFailure(error)) {
    await withMemoryWriteGateAsync(context, () => db.transaction(() => {
      const owned = db.query("SELECT 1 FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE w.window_ref=? AND w.job_id=? AND w.state='running' AND w.owner_nonce=?").get(pending.window_ref, pending.job_id, pending.ownerNonce);
      if (!owned) throw new Error("memory_projection_window_changed");
      const rows = sourceRows(db, pending.sourceRefs).sort((a, b) => pending.sourceRefs.indexOf(a.source_id) - pending.sourceRefs.indexOf(b.source_id));
      const split = splitWindowSourceRows(db, generation.sourceRoot, rows);
      if (!split) {
        markWindowFailure(db, pending.job_id, pending.window_ref, "extraction_budget_exceeded", {
          ownerNonce: pending.ownerNonce, attemptKind: attempt.providerInvoked ? "provider" : "pre_provider",
          providerInvoked: attempt.providerInvoked, clearResult: !attempt.preserveResult,
          failureEvidence: attempt.failureEvidence,
        });
        return;
      }
      recordWindowAttemptFailure(db, pending.job_id, pending.window_ref, safeProjectionError(error), {
        ownerNonce: pending.ownerNonce, attemptKind: attempt.providerInvoked ? "provider" : "pre_provider",
        providerInvoked: attempt.providerInvoked, clearResult: !attempt.preserveResult,
        failureEvidence: attempt.failureEvidence,
      });
      splitProjectionWindow(db, { jobId: pending.job_id, windowRef: pending.window_ref, ownerNonce: pending.ownerNonce, children: split });
    })());
    const vectorText = episodeProjectionTextForJob(generation.sourceRoot, db, pending.job_id);
    await withMemoryWriteGateAsync(context, () => {
      assertJobRevisionCurrent(generation.sourceRoot, db, pending.job_id);
      refreshVectorUnitsForJob(db, pending.job_id, vectorText);
    });
    return;
  }
  const providerAttempt = pending.recoveryAttemptCount + (attempt.providerInvoked ? 1 : 0);
  let splitCreated = false;
  const failure = retryDecision(error, providerAttempt);
  await withMemoryWriteGateAsync(context, () => db.transaction(() => {
    markWindowFailure(db, pending.job_id, pending.window_ref, attempt.failureCode ?? safeProjectionError(error), {
      retryAt: failure.retryAt, ownerNonce: pending.ownerNonce,
      attemptKind: attempt.providerInvoked ? "provider" : "pre_provider", providerInvoked: attempt.providerInvoked,
      clearResult: !attempt.preserveResult,
      failureEvidence: attempt.failureEvidence,
    });
    if (providerAttempt === 3) splitCreated = Boolean(splitExhaustedLocalTimeoutWindow(generation.sourceRoot, db, pending.window_ref));
  })());
  if (splitCreated) {
    const vectorText = episodeProjectionTextForJob(generation.sourceRoot, db, pending.job_id);
    await withMemoryWriteGateAsync(context, () => {
      assertJobRevisionCurrent(generation.sourceRoot, db, pending.job_id);
      refreshVectorUnitsForJob(db, pending.job_id, vectorText);
    });
  }
}

function replacementSourceRefs(db: ReturnType<typeof openProjectionDb>, sourceId: string): string[] {
  const leaves = expandSplitSourceLeaves(db, sourceId);
  return leaves.length === 1 && leaves[0] === sourceId ? [] : leaves;
}

function advanceHotCacheQuantum(
  context: MemoryExecutionContext,
  generation: MemoryGenerationHandle,
  db: ReturnType<typeof openProjectionDb>,
  jobId: string,
): void {
  const row = db.query<{ episode_id: string; revision: string; generation: string; summary: string; summary_status: string; project_id: string | null; conversation_session_id: string | null; conversation_start: string; source_kind: "conversation" | "task_report" | "explicit_record"; semantic_graph_state: string; hot_cache_attempt_count: number }, [string]>(`
    SELECT j.episode_id,j.revision,j.generation,c.summary,c.summary_status,c.project_id,c.conversation_session_id,c.conversation_start,
      (SELECT source_kind FROM memory_chunk_sources s WHERE s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision LIMIT 1) source_kind,
      j.semantic_graph_state,j.hot_cache_attempt_count
    FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.job_id=?
  `).get(jobId);
  if (!row) throw new Error("memory_source_changed");
  assertJobRevisionCurrent(generation.sourceRoot, db, jobId);
  const nonce = randomUUID();
  const startedAt = new Date().toISOString();
  const attempt = Number(row.hot_cache_attempt_count) + 1;
  db.query("UPDATE memory_projection_jobs SET hot_cache_attempt_count=?,hot_cache_owner_pid=?,hot_cache_owner_nonce=?,hot_cache_started_at=?,hot_cache_state=? WHERE job_id=?")
    .run(attempt, process.pid, nonce, startedAt, JSON.stringify({ state: "running", attempt, owner_pid: process.pid, started_at: startedAt }), jobId);
  const semantic = JSON.parse(row.semantic_graph_state) as { state: string; pending_units?: number };
  const semanticTerminal = ["complete", "failed"].includes(semantic.state) ||
    (semantic.state === "partial" && Number(semantic.pending_units ?? 0) === 0);
  if (row.summary_status !== "complete" || !row.summary.trim()) {
    if (!semanticTerminal) return;
    const receipt = { schema: "butler.memory-hot-cache-receipt.v1", outcome: "excluded", reason: "no_summary", generation: row.generation, episode_id: row.episode_id, source_revision: row.revision };
    db.query("UPDATE memory_projection_jobs SET hot_cache_state=?,hot_cache_receipt_json=?,hot_cache_owner_pid=NULL,hot_cache_owner_nonce=NULL,hot_cache_started_at=NULL WHERE job_id=?")
      .run(JSON.stringify({ state: "complete", completed_units: 1, total_units: 1 }), JSON.stringify(receipt), jobId);
    return;
  }
  try {
    const graphRevision = Number(db.query<{ value: string }, []>("SELECT value FROM memory_state WHERE key='graph_revision'").get()?.value ?? 0);
    const windows = db.query<{ window_ref: string; output_json: string | null; normalized_plan_json: string | null; source_refs_json: string }, [string]>(
      "SELECT window_ref,output_json,normalized_plan_json,source_refs_json FROM memory_projection_windows WHERE job_id=? AND state='complete' ORDER BY ordinal,window_ref",
    ).all(jobId).flatMap((window) => {
      try {
        const output = JSON.parse(window.output_json ?? "null") as { summary?: { text?: string; evidence?: Array<{ unit_ref?: string }> } | null; claims?: Array<{ type?: string; valid_to?: string | null; salience?: "high" | "normal" | "unspecified"; basis?: string }> } | null;
        const plan = JSON.parse(window.normalized_plan_json ?? "null") as { refs?: Record<string, string> } | null;
        const summary = output?.summary?.text?.trim();
        if (!summary) return [];
        const windowSourceRefs = new Set(JSON.parse(window.source_refs_json) as string[]);
        const summarySourceRefs = [...new Set((output?.summary?.evidence ?? []).flatMap((quote) =>
          quote.unit_ref && windowSourceRefs.has(quote.unit_ref) ? [quote.unit_ref] : [],
        ))];
        if (summarySourceRefs.length === 0) return [];
        const summarySources = sourceRows(db, summarySourceRefs);
        if (summarySources.length !== summarySourceRefs.length) return [];
        const claims = output?.claims ?? [];
        const validity = claims.flatMap((claim) => claim.valid_to ? [claim.valid_to] : []).sort()[0] ?? null;
        const salience = claims.some((claim) => claim.salience === "high") ? "high" as const
          : claims.some((claim) => claim.salience === "normal") ? "normal" as const : "unspecified" as const;
        return [{ window_ref: window.window_ref, summary, valid_until: validity, salience,
          kind: [...new Set(claims.flatMap((claim) => claim.type ? [claim.type] : []))].join("+") || "window_summary",
          basis: [...new Set(summarySources.map((source) => source.basis))].sort(),
          source_refs: summarySourceRefs,
          node_refs: [...new Set(Object.values(plan?.refs ?? {}))].sort(),
        }];
      } catch { return []; }
    });
    const receipts = windows.map((window) => {
      const entryId = projectionHash(["hot-cache-window-summary", row.generation, row.episode_id, window.window_ref, row.revision, window.summary]);
      return writeSemanticHotCacheEntry({
        butlerData: context.butlerData,
        generationRoot: generation.root,
        generationId: row.generation,
        episodeId: row.episode_id,
        sourceRevision: row.revision,
        scope: row.project_id ? "project" : "global",
        projectId: row.project_id,
        sessionId: row.conversation_session_id,
        sourceId: entryId,
        body: window.summary,
        createdAt: row.conversation_start,
        entry: {
          entry_id: entryId, episode_id: row.episode_id, window_ref: window.window_ref,
          node_refs: window.node_refs, source_revision: row.revision, source_time: row.conversation_start,
          valid_until: window.valid_until, kind: window.kind, summary: window.summary,
          basis: window.basis, salience: window.salience, scope: row.project_id ? "project" : "global",
          project_id: row.project_id, session_id: row.conversation_session_id, graph_revision: graphRevision,
          source_kind: row.source_kind,
          source_refs: window.source_refs,
        },
        memoryContext: context,
        resolvedGeneration: generation,
        sourceButlerData: generation.sourceRoot,
      });
    });
    if (receipts.length === 0) throw new Error("hot_cache_entry_empty");
    assertJobRevisionCurrent(generation.sourceRoot, db, jobId);
    db.query("UPDATE memory_projection_jobs SET hot_cache_state=?,hot_cache_receipt_json=?,hot_cache_owner_pid=NULL,hot_cache_owner_nonce=NULL,hot_cache_started_at=NULL WHERE job_id=?")
      .run(JSON.stringify({ state: "complete", completed_units: 1, total_units: 1 }), JSON.stringify({ outcome: receipts.some((receipt) => receipt.admitted) ? "applied" : "excluded", entries: receipts }), jobId);
  } catch (error) {
    const code = error instanceof Error && /^hot_cache_[a-z0-9_]+$/u.test(error.message) ? error.message : "hot_cache_io_failed";
    const retryAt = attempt < 3 ? new Date(Date.now() + (attempt === 1 ? 30_000 : 120_000)).toISOString() : null;
    db.query("UPDATE memory_projection_jobs SET hot_cache_state=?,hot_cache_receipt_json=?,hot_cache_owner_pid=NULL,hot_cache_owner_nonce=NULL,hot_cache_started_at=NULL WHERE job_id=?")
      .run(JSON.stringify(retryAt ? { state: "pending", blocked_by: code } : { state: "failed", code, retryable: false, next_attempt_at: null }), JSON.stringify({ outcome: "failed", code, retry_at: retryAt }), jobId);
    db.query("UPDATE memory_projection_jobs SET hot_cache_next_attempt_at=? WHERE job_id=?").run(retryAt, jobId);
  }
}

function assertJobRevisionCurrent(sourceRoot: string, db: ReturnType<typeof openProjectionDb>, jobId: string): void {
  const row = db.query<{ episode_id: string; revision: string }, [string]>("SELECT episode_id,revision FROM memory_projection_jobs WHERE job_id=?").get(jobId);
  if (!row) throw new Error("memory_projection_job_not_found");
  assertCanonicalRevisionCurrentForEpisode(sourceRoot, db, row.episode_id, row.revision);
}

function assertCanonicalRevisionCurrentForEpisode(sourceRoot: string, db: ReturnType<typeof openProjectionDb>, episodeId: string, revision: string): void {
  const chunk = db.query<{ conversation_turn_id: string | null; conversation_session_id: string | null; source_key: string; current_revision: string }, [string]>("SELECT conversation_turn_id,conversation_session_id,source_key,current_revision FROM memory_chunks WHERE memory_chunk_id=?").get(episodeId);
  if (!chunk || chunk.current_revision !== revision) throw new Error("memory_source_changed");
  if (chunk.source_key.startsWith("task_report:") || chunk.source_key.startsWith("explicit_record:")) {
    const [kind, recordId] = chunk.source_key.split(":") as ["task_report" | "explicit_record", string];
    const owner = readTypedMemoryRecord(sourceRoot, kind, recordId, { unavailable: "throw" });
    if (!owner || owner.revision !== revision) throw new Error("memory_source_changed");
    return;
  }
  if (!chunk.conversation_session_id) throw new Error("memory_source_changed");
  const snapshotPath = join(sourceRoot, "runtime", "conversation-store.sqlite");
  const canonical = createLazyConversationProjectionReader({ butlerData: sourceRoot, dbPath: existsSync(snapshotPath) ? snapshotPath : undefined });
  try {
    if (chunk.conversation_turn_id) {
      const outcome = canonical.readTurnOutcome(chunk.conversation_turn_id);
      if (!outcome) throw new Error("memory_source_changed");
      assertCanonicalRevisionCurrent({ canonical, turnId: chunk.conversation_turn_id, sessionId: chunk.conversation_session_id, outcomeGeneration: outcome.generation, expectedRevision: revision });
    } else {
      const messageId = chunk.source_key.startsWith("conversation_message:") ? chunk.source_key.slice("conversation_message:".length) : "";
      const message = canonical.readMessageById(messageId);
      if (!message || message.session_id !== chunk.conversation_session_id || !eligibleStandaloneMessage(message)) throw new Error("memory_source_changed");
      const scalars = decodeMessageScalars(message);
      const expectedRevision = projectionHash(["episode-revision", ...scalars.flatMap((scalar) => [scalar.message.id, scalar.part.id, scalar.pointer, scalar.hash]), recoveredMessageSourceHash(message)]);
      const current = db.query<{ current_revision: string }, [string]>("SELECT current_revision FROM memory_chunks WHERE memory_chunk_id=?").get(episodeId);
      if (expectedRevision !== revision || current?.current_revision !== revision) throw new Error("memory_source_changed");
    }
  } finally { canonical.close(); }
}

function vectorFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "memory_embedding_failed";
  return /^[a-z0-9_]+$/u.test(message) ? message : "memory_embedding_failed";
}
