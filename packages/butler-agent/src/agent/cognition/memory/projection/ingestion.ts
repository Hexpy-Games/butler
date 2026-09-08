import { AgentConversationStore } from "../../../conversation/store.ts";
import { readProfilingExtractorModelConfig } from "../../../../personalization/profiling.ts";
import type { ConversationMessageWithParts } from "../../../conversation/types.ts";
import {
  readActiveDescriptor,
  resolveMemoryGeneration,
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
  openProjectionDb,
  progressFromDb,
  refreshSemanticState,
  saveValidatedPlan,
  sourceRows,
  type ProjectionSourceRow,
} from "./store.ts";
import { runStructuredMemoryExtractor } from "./extractor.ts";
import { unicodeCaseFold } from "./unicode.ts";
import {
  acquireConsolidationLock,
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
  assertPlanSourceCurrent,
  normalizeAndValidatePlan,
  safeProjectionError,
  type NormalizedPlan,
} from "./plan.ts";

const MAX_WINDOW_BYTES = 8192;
const MAX_INPUT_BYTES = 24 * 1024;

export async function ingestConversationMemory(input: {
  context: MemoryExecutionContext;
  source: MemorySourceNotice;
  completionJobId?: string;
}): Promise<MemoryJobProgress> {
  if (input.context.signal.aborted)
    throw new Error("memory_projection_aborted");
  const generation = resolveMemoryGeneration(input.context);
  const canonical = new AgentConversationStore({
    butlerData: input.context.butlerData,
  });
  try {
    const turn = canonical.readTurn(input.source.turn_id);
    const outcome = canonical.readTurnOutcome(input.source.turn_id);
    if (
      !turn ||
      !outcome ||
      turn.session_id !== input.source.session_id ||
      outcome.generation !== input.source.outcome_generation ||
      !["complete", "failed", "aborted"].includes(turn.status)
    )
      throw new Error("memory_source_not_terminal");
    const messages = eligibleCanonicalMessages(
      canonical,
      outcome,
      "memory_source_ineligible",
    );
    const scalars = messages.flatMap(decodeMessageScalars);
    if (scalars.length === 0) throw new Error("memory_source_text_missing");
    const episodeId = projectionHash(["canonical-conversation-turn", turn.id]);
    const revision = projectionHash([
      "episode-revision",
      ...scalars.flatMap((s) => [s.message.id, s.part.id, s.pointer, s.hash]),
      outcome.generation,
    ]);
    const jobId = projectionHash([
      "memory-projection",
      episodeId,
      revision,
      MEMORY_EXTRACTION_VERSION,
    ]);
    const model = readProfilingExtractorModelConfig(input.context.butlerData);
    const db = openProjectionDb(generation.graphPath);
    try {
      withMemoryWriteGate(input.context, () =>
        db.transaction(() => {
          assertCanonicalRevisionCurrent({
            canonical,
            turnId: turn.id,
            sessionId: turn.session_id,
            outcomeGeneration: outcome.generation,
            expectedRevision: revision,
          });
          const now = new Date().toISOString();
          db.query(
            `INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,conversation_start,conversation_end,project_id,origin_kind,status,source_hash,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?) ON CONFLICT(source_key) DO UPDATE SET current_revision=excluded.current_revision,updated_at=excluded.updated_at`,
          ).run(
            episodeId,
            `conversation_turn:${turn.id}`,
            revision,
            turn.session_id,
            turn.id,
            messages[0]?.created_at ?? turn.started_at,
            messages.at(-1)?.created_at ?? turn.completed_at,
            canonical.getSession(turn.session_id)?.project_id ?? null,
            combinedOrigin(messages),
            revision,
            now,
            now,
          );
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
          const notConfigured = {
            state: "not_configured",
            code: "embedding_not_configured",
          };
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
            JSON.stringify(
              input.completionJobId ? [input.completionJobId] : [],
            ),
            JSON.stringify(sourceState),
            JSON.stringify(pending),
            JSON.stringify(notConfigured),
            JSON.stringify(pending),
            JSON.stringify(pending),
            now,
          );
          const windows = packWindows(registered, db, MAX_WINDOW_BYTES);
          windows.forEach((refs, index) =>
            db
              .query(
                "INSERT OR IGNORE INTO memory_projection_windows(window_ref,job_id,ordinal,source_refs_json,state) VALUES(?,?,?,?,'pending')",
              )
              .run(
                projectionHash(["memory-window", revision, ...refs]),
                jobId,
                index,
                JSON.stringify(refs),
              ),
          );
        })(),
      );
      return progressFromDb(db, jobId);
    } finally {
      db.close();
    }
  } finally {
    canonical.close();
  }
}

export async function advanceNextMemoryProjection(input: {
  context: MemoryExecutionContext;
}): Promise<MemoryJobProgress | null> {
  const generation = resolveMemoryGeneration(input.context);
  const db = openProjectionDb(generation.graphPath);
  const pending = withMemoryWriteGate(input.context, () =>
    claimNextProjectionWindow(db),
  );
  if (!pending) {
    db.close();
    return null;
  }
  try {
    const extractInput = buildExtractInput(
      input.context.butlerData,
      db,
      pending.job_id,
      pending.window_ref,
      pending.sourceRefs,
    );
    if (pending.previousState === "planned") {
      if (!pending.output || !pending.plan)
        throw new Error("memory_projection_plan_missing");
      withMemoryWriteGate(input.context, () => {
        assertProjectionSourceCurrent(
          input.context.butlerData,
          db,
          extractInput,
        );
        applyPlan(
          db,
          pending.job_id,
          pending.window_ref,
          extractInput,
          pending.output!,
          pending.plan as NormalizedPlan,
        );
      });
      return progressFromDb(db, pending.job_id);
    }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 180_000);
    const signal = AbortSignal.any([input.context.signal, timeout.signal]);
    let output: ExtractOutput;
    let providerEvidence: unknown;
    try {
      const extraction = await runStructuredMemoryExtractor({
        butlerData: input.context.butlerData,
        extractInput,
        model: pending.model,
        reasoningEffort: pending.reasoningEffort,
        signal,
      });
      output = extraction.output;
      providerEvidence = extraction.evidence;
      withMemoryWriteGate(input.context, () => {
        assertProjectionSourceCurrent(
          input.context.butlerData,
          db,
          extractInput,
        );
        const saved = db.query(
          `UPDATE memory_projection_windows
           SET output_json=?,provider_evidence_json=?
           WHERE window_ref=? AND job_id=? AND state='running'`,
        ).run(
          JSON.stringify(output),
          JSON.stringify(providerEvidence),
          pending.window_ref,
          pending.job_id,
        );
        if (saved.changes !== 1) {
          throw new Error("memory_projection_window_changed");
        }
      });
      const plan = normalizeAndValidatePlan(db, extractInput, output);
      withMemoryWriteGate(input.context, () => {
        assertProjectionSourceCurrent(
          input.context.butlerData,
          db,
          extractInput,
        );
        saveValidatedPlan(db, pending.job_id, pending.window_ref, output, plan);
      });
      resolveMemoryGeneration(input.context);
      withMemoryWriteGate(input.context, () => {
        assertProjectionSourceCurrent(
          input.context.butlerData,
          db,
          extractInput,
        );
        applyPlan(
          db,
          pending.job_id,
          pending.window_ref,
          extractInput,
          output,
          plan,
        );
      });
      return progressFromDb(db, pending.job_id);
    } catch (error) {
      withMemoryWriteGate(input.context, () =>
        markFailure(db, pending.job_id, pending.window_ref, error),
      );
      return progressFromDb(db, pending.job_id);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    db.close();
  }
}

export function resolveMemorySource(input: {
  context: MemoryExecutionContext;
  sourceRef: string;
  maxChars?: number;
}): ResolvedMemorySource {
  const generation = resolveMemoryGeneration(input.context);
  const db = openProjectionDb(generation.graphPath, true);
  try {
    const row = sourceRows(db, [input.sourceRef])[0];
    if (!row) throw new Error("memory_source_not_found");
    return hydrateSource(input.context.butlerData, row, input.maxChars);
  } finally {
    db.close();
  }
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

function buildExtractInput(
  butlerData: string,
  db: ReturnType<typeof openProjectionDb>,
  jobId: string,
  windowRef: string,
  refs: string[],
): ExtractInput {
  const rows = sourceRows(db, refs);
  if (rows.length !== refs.length) throw new Error("memory_source_changed");
  const chunk = db
    .query<
      {
        memory_chunk_id: string;
        current_revision: string;
        project_id: string | null;
      },
      [string]
    >(
      "SELECT c.memory_chunk_id,c.current_revision,c.project_id FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id WHERE j.job_id=?",
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
        (unit.role !== "user" && unit.role !== "assistant"),
    )
  ) {
    throw new Error("memory_source_ineligible");
  }
  const folded = unicodeCaseFold(
    source_units.map((unit) => unit.text).join("\n"),
  );
  const aliasRows = db
    .query<
      {
        id: string;
        type: string;
        identity_scope: "user" | "project";
        project_id: string | null;
        surface_original: string;
        source_id: string;
      },
      [string, string | null, string | null, string | null, string | null]
    >(
      `
    SELECT e.id,e.type,e.identity_scope,e.project_id,a.surface_original,a.source_id
    FROM entity_aliases a
    JOIN entities e ON e.id=a.entity_id
    JOIN memory_chunk_sources s ON s.source_id=a.source_id
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE instr(?,a.folded_key)>0
      AND s.origin_kind IN ('user_input','assistant_public')
      AND (c.project_id IS NULL OR c.project_id IS ?)
      AND (
        e.type IN ('entity','project')
        OR (? IS NULL AND e.identity_scope='user' AND e.project_id IS NULL)
        OR (? IS NOT NULL AND e.identity_scope='project' AND e.project_id IS ?)
      )
    ORDER BY length(a.folded_key) DESC LIMIT 96
  `,
    )
    .all(
      folded,
      chunk.project_id,
      chunk.project_id,
      chunk.project_id,
      chunk.project_id,
    );
  const candidates = [
    ...new Map(aliasRows.map((row) => [row.id, row])).values(),
  ]
    .slice(0, 32)
    .map((row) => {
      const aliases = aliasRows
        .filter((alias) => alias.id === row.id)
        .slice(0, 3);
      const evidence = aliases.slice(0, 2).map((alias) => {
        const source = sourceRows(db, [alias.source_id])[0];
        const resolved = hydrateSource(butlerData, source, 160);
        return {
          ref: source.source_id,
          text: resolved.excerpt,
          observed_at: source.observed_at,
          basis:
            source.basis as ExtractInput["candidates"][number]["evidence"][number]["basis"],
        };
      });
      return {
        ref: row.id,
        type: row.type as ExtractInput["candidates"][number]["type"],
        label: row.surface_original,
        aliases: aliases.map((a) => a.surface_original),
        scope: row.identity_scope,
        project_id: row.project_id,
        evidence,
      };
    });
  const context_units = readPriorPublicContext(
    butlerData,
    rows[0]?.conversation_session_id ?? "",
    source_units,
  );
  const input: ExtractInput = {
    schema: "butler.memory-extract-input.v2",
    episode_ref: chunk.memory_chunk_id,
    revision: chunk.current_revision,
    window_ref: windowRef,
    bound_project_id: chunk.project_id,
    source_units,
    context_units,
    candidates,
  };
  while (
    Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES &&
    input.candidates.length
  )
    input.candidates.pop();
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES)
    throw new Error("memory_extract_input_exceeds_budget");
  return input;
}

function markFailure(
  db: ReturnType<typeof openProjectionDb>,
  jobId: string,
  windowRef: string,
  error: unknown,
): void {
  db.query(
    "UPDATE memory_projection_windows SET state='failed',error_code=? WHERE window_ref=?",
  ).run(safeProjectionError(error), windowRef);
  refreshSemanticState(db, jobId);
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
        conversation_turn_id: string;
        conversation_session_id: string;
      },
      [string]
    >(
      "SELECT conversation_turn_id,conversation_session_id FROM memory_chunks WHERE memory_chunk_id=?",
    )
    .get(input.episode_ref);
  if (!chunk?.conversation_turn_id || !chunk.conversation_session_id) {
    throw new Error("memory_source_changed");
  }
  const canonical = new AgentConversationStore({ butlerData });
  try {
    const outcome = canonical.readTurnOutcome(chunk.conversation_turn_id);
    if (!outcome) throw new Error("memory_source_changed");
    assertCanonicalRevisionCurrent({
      canonical,
      turnId: chunk.conversation_turn_id,
      sessionId: chunk.conversation_session_id,
      outcomeGeneration: outcome.generation,
      expectedRevision: input.revision,
    });
  } finally {
    canonical.close();
  }
}

function assertCanonicalRevisionCurrent(input: {
  canonical: AgentConversationStore;
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
  canonical: AgentConversationStore,
  outcome: NonNullable<
    ReturnType<AgentConversationStore["readTurnOutcome"]>
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

function withMemoryWriteGate<T>(
  context: MemoryExecutionContext,
  run: () => T,
): T {
  const path = consolidationLockPath(context.butlerData);
  const lease = acquireConsolidationLock(path, {
    purpose: "memory_projection",
  });
  if (!lease) throw new Error("memory_write_busy");
  try {
    resolveMemoryGeneration(context);
    return run();
  } finally {
    releaseConsolidationLock(path, lease);
  }
}
