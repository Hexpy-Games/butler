import { existsSync } from "fs";
import { join } from "path";
import { cognitionMemoryRoot } from "../../paths.ts";
import type { Database } from "bun:sqlite";
import { embedViaSocket } from "../scripts/embed.ts";
import {
  embedCheckedViaSocket,
  type EmbeddingRuntimeMetadata,
} from "../scripts/embed.ts";
import type {
  GenerationEmbedding,
  MemoryGenerationHandle,
} from "../projection/generation.ts";
import type { ClaimedVectorUnit } from "../projection/store.ts";
import type { RecallCandidate } from "./engine.ts";
import type { RecallProjectFilter, RecallScope } from "./contracts.ts";
import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";

export interface VectorEpisodeRow {
  id?: string;
  text?: string;
  project?: string;
  type?: string;
  session_id?: string;
  timestamp?: number;
  source?: string;
  topic?: string;
  _distance?: number;
  _score?: number;
}

export interface VectorEpisodeBackend {
  supportsProjectFilter?: boolean;
  embed(query: string, timeoutMs: number): Promise<number[] | null>;
  search(input: {
    dbPath: string;
    tableName: string;
    vector: number[];
    limit: number;
    fallbackLimit?: number;
    projectId?: string;
  }): Promise<VectorEpisodeSearchRows>;
}

export type VectorProjectFilterMode = "none" | "prefilter" | "postfilter";

export type VectorEpisodeSearchRows =
  | VectorEpisodeRow[]
  | {
    rows: VectorEpisodeRow[];
    projectFilterMode?: VectorProjectFilterMode;
    limit?: number;
  };

export interface VectorEpisodeSearchResult {
  candidates: RecallCandidate[];
  diagnostics: string[];
}

const VECTOR_SEARCH_MIN_LIMIT = 1;
const VECTOR_SEARCH_DEFAULT_LIMIT = 5;
const VECTOR_SEARCH_MAX_LIMIT = 10;
const VECTOR_SEARCH_MIN_TIMEOUT_MS = 200;
const VECTOR_SEARCH_DEFAULT_TIMEOUT_MS = 1_500;
const VECTOR_SEARCH_MAX_TIMEOUT_MS = 10_000;
const VECTOR_SEARCH_OVERFETCH_MULTIPLIER = 5;
const VECTOR_SEARCH_OVERFETCH_MAX_LIMIT = 50;
const VECTOR_CIRCUIT_FAILURE_THRESHOLD = 3;
const VECTOR_CIRCUIT_COOLDOWN_MS = 30_000;
const VECTOR_CANDIDATE_SUMMARY_CHARS = 420;
const GENERATION_VECTOR_READER_LIMIT = 4;
type LanceMemoryTable = {
  search(vector: number[]): LanceDbSearchBuilder;
  schema(): Promise<{ fields: Array<{ name: string; nullable: boolean }> }>;
};
const generationVectorReaders = new Map<string, Promise<LanceMemoryTable>>();

export type GenerationVectorRow = {
  vector_key: string;
  generation: string;
  record_kind: "node" | "episode";
  owner_id: string;
  owner_revision: string;
  source_revision: string;
  embedding_chunk_id: string;
  embedding_version: string;
  project_id: string;
  origin_kind: string;
  source_kind: string;
  conversation_session_id: string | null;
  source_observed_at: string;
  source_refs_json: string;
  text: string;
  vector: number[];
};

export type GenerationVectorMatches = {
  nodes: GenerationVectorMatch[];
  episodes: GenerationVectorMatch[];
  diagnostics: string[];
};

export type GenerationVectorMatch = {
  vectorKey: string;
  generation: string;
  embeddingChunkId: string;
  embeddingVersion: string;
  ownerId: string;
  ownerRevision: string;
  sourceRevision: string;
  sourceRefsJson: string;
  projectId: string;
  originKind: string;
  sourceKind?: string;
  conversationSessionId: string | null;
  sourceObservedAt: string;
  sourceEpisodeId?: string;
  rank: number;
  distance: number;
};

export type GenerationVectorMembershipScope = {
  scope: RecallScope;
  projectFilter: RecallProjectFilter;
  projectIds: string[];
  runtimeProjectId: string | null;
  runtimeSessionId: string;
  sessionIds: string[];
  asOf: string;
  time?: { from: string; to: string; basis: "conversation" | "event" };
  sourceProjectId?: string | null;
  includeInternal: boolean;
  eventEpisodeEligibility?: (
    episodeExpression: "j.episode_id",
  ) => { sql: string; args: Array<string | null> };
};

export async function searchGenerationVectors(input: {
  butlerData?: string;
  generation: MemoryGenerationHandle;
  phrases: string[];
  scope: RecallScope;
  projectFilter: RecallProjectFilter;
  projectIds: string[];
  runtimeProjectId: string | null;
  runtimeSessionId: string;
  sessionIds: string[];
  asOf: string;
  time?: { from: string; to: string; basis: "conversation" | "event" };
  sourceProjectId?: string | null;
  includeInternal: boolean;
  includeEpisodes?: boolean;
  socketPath?: string;
  deadlineAt: number;
  signal?: AbortSignal;
}): Promise<GenerationVectorMatches> {
  if (!input.generation.embedding) {
    throw new Error("memory_embedding_not_configured");
  }
  const allPhrases = uniqueNfc(input.phrases);
  const phrases = allPhrases.slice(0, 4);
  const omittedPhrases = allPhrases.length - phrases.length;
  assertRecallDeadline(input.deadlineAt);
  const embeddingStartedAt = performance.now();
  const checked = await embedCheckedViaSocket({
    texts: phrases.flatMap(initialGraphemeChunks),
    expected: input.generation.embedding,
    socketPath: input.socketPath,
    timeoutMs: Math.max(1, input.deadlineAt - Date.now()),
    deadlineAt: input.deadlineAt,
    requestClass: "interactive",
    resplit: true,
    maxEmbeddings: 4,
    signal: input.signal,
  });
  recordOperationalMetric({
    category: "memory",
    name: "recall_v2_checked_embedding",
    status: "ok",
    durationMs: performance.now() - embeddingStartedAt,
    value: checked.embeddings.length,
    unit: "vectors",
  }, { butlerData: input.butlerData });
  const vectors = checked.embeddings;
  const omitted = checked.omitted_count ?? 0;
  const lanceOpenStartedAt = performance.now();
  const readerKey =
    `${input.generation.generationId}:${input.generation.embedding.version}:${input.generation.root}`;
  const reused = generationVectorReaders.has(readerKey);
  let reader = generationVectorReaders.get(readerKey);
  if (!reader) {
    reader = (async () => {
      const lancedb = await import("@lancedb/lancedb");
      const connection = await lancedb.connect(
        join(input.generation.root, "butler.lance"),
        { readConsistencyInterval: 0 },
      );
      return await connection.openTable(
        "butler_memory",
      ) as unknown as LanceMemoryTable;
    })();
    generationVectorReaders.set(readerKey, reader);
    while (generationVectorReaders.size > GENERATION_VECTOR_READER_LIMIT) {
      generationVectorReaders.delete(
        generationVectorReaders.keys().next().value!,
      );
    }
  }
  let table: LanceMemoryTable;
  try {
    table = await withinRecallDeadline(reader, input.deadlineAt);
  } catch (error) {
    generationVectorReaders.delete(readerKey);
    throw error;
  }
  recordOperationalMetric({
    category: "memory",
    name: "recall_v2_lance_open",
    status: "ok",
    durationMs: performance.now() - lanceOpenStartedAt,
    dimensions: { reused: String(reused) },
  }, { butlerData: input.butlerData });
  const boundReached = new Set<"node" | "episode">();
  let invalidRows = 0;
  const legacyConversationRows = !(await table.schema()).fields.some(
    (field) => field.name === "source_kind",
  );
  const collect = async (kind: "node" | "episode") => {
    const searchStartedAt = performance.now();
    const bestRows = new Map<string, Omit<GenerationVectorMatch, "rank">>();
    for (const vector of vectors) {
      assertRecallDeadline(input.deadlineAt);
      const clauses = [
        `record_kind = ${lanceStringLiteral(kind)}`,
        `embedding_version = ${
          lanceStringLiteral(input.generation.embedding!.version)
        }`,
        `generation = ${lanceStringLiteral(input.generation.generationId)}`,
      ];
      if (!input.includeInternal) {
        clauses.push(
          legacyConversationRows
            ? "origin_kind IN ('user_input','assistant_public')"
            : "((source_kind='conversation' AND origin_kind IN ('user_input','assistant_public')) OR source_kind IN ('task_report','explicit_record'))",
        );
      }
      if (kind === "episode" && input.scope === "current_session") {
        clauses.push(
          `conversation_session_id = ${
            lanceStringLiteral(input.runtimeSessionId)
          }`,
        );
      }
      if (kind === "episode" && input.sessionIds.length) {
        clauses.push(
          `conversation_session_id IN (${
            input.sessionIds.map(lanceStringLiteral).join(",")
          })`,
        );
      }
      if (kind === "episode") {
        clauses.push(`source_observed_at <= ${lanceStringLiteral(input.asOf)}`);
      }
      if (kind === "episode" && input.time?.basis === "conversation") {
        clauses.push(
          `source_observed_at >= ${lanceStringLiteral(input.time.from)}`,
        );
        clauses.push(
          `source_observed_at < ${lanceStringLiteral(input.time.to)}`,
        );
      }
      if (input.scope === "current_project") {
        clauses.push(
          input.runtimeProjectId === null
            ? "project_id = ''"
            : `project_id = ${lanceStringLiteral(input.runtimeProjectId)}`,
        );
      }
      if (input.projectFilter === "unassigned") clauses.push("project_id = ''");
      if (input.projectFilter === "selected") {
        if (!input.projectIds.length) return [];
        clauses.push(
          `project_id IN (${
            input.projectIds.map(lanceStringLiteral).join(",")
          })`,
        );
      }
      if (input.sourceProjectId !== undefined) {
        clauses.push(
          input.sourceProjectId === null
            ? "project_id = ''"
            : `(project_id = '' OR project_id = ${
              lanceStringLiteral(input.sourceProjectId)
            })`,
        );
      }
      const rows = await withinRecallDeadline(
        (table.search(vector) as LanceDbSearchBuilder).where!(
          clauses.join(" AND "),
        ).limit(256).toArray(),
        input.deadlineAt,
      ) as Array<Partial<GenerationVectorRow> & { _distance?: number }>;
      if (rows.length >= 256) boundReached.add(kind);
      for (const row of rows) {
        if (validGenerationVectorSearchRow(row, kind, legacyConversationRows)) {
          const prior = bestRows.get(row.vector_key);
          if (!prior || row._distance < prior.distance) {
            bestRows.set(row.vector_key, {
              vectorKey: row.vector_key,
              generation: row.generation,
              embeddingChunkId: row.embedding_chunk_id,
              embeddingVersion: row.embedding_version,
              ownerId: row.owner_id,
              ownerRevision: row.owner_revision,
              sourceRevision: row.source_revision,
              sourceRefsJson: row.source_refs_json,
              projectId: row.project_id,
              originKind: row.origin_kind,
              sourceKind: row.source_kind ?? "conversation",
              conversationSessionId: row.conversation_session_id,
              sourceObservedAt: row.source_observed_at,
              distance: row._distance,
            });
          }
        } else invalidRows += 1;
      }
    }
    const result = [...bestRows.values()].sort((a, b) =>
      a.distance - b.distance ||
      Buffer.compare(Buffer.from(a.vectorKey), Buffer.from(b.vectorKey)),
    )
      .map((value, index) => ({ ...value, rank: index + 1 }));
    recordOperationalMetric({
      category: "memory",
      name: "recall_v2_lance_search",
      status: "ok",
      durationMs: performance.now() - searchStartedAt,
      value: result.length,
      unit: "candidates",
      dimensions: { record_kind: kind },
    }, { butlerData: input.butlerData });
    return result;
  };
  const nodes = await collect("node");
  const episodes = input.includeEpisodes === false ? [] : await collect("episode");
  return {
    nodes,
    episodes,
    diagnostics: [
      ...(omittedPhrases ? [`vector_phrases_omitted=${omittedPhrases}`] : []),
      ...(omitted ? [`vector_chunks_omitted=${omitted}`] : []),
      ...(invalidRows ? [`vector_rows_invalid=${invalidRows}`] : []),
      ...[...boundReached].sort().map((kind) => `${kind}_vector_bound_reached`),
    ],
  };
}

function validGenerationVectorSearchRow(
  row: Partial<GenerationVectorRow> & { _distance?: number },
  kind: "node" | "episode",
  legacyConversationRows = false,
): row is GenerationVectorRow & { _distance: number } {
  return row.record_kind === kind && typeof row.vector_key === "string" &&
    typeof row.generation === "string" &&
    typeof row.embedding_chunk_id === "string" &&
    typeof row.embedding_version === "string" &&
    typeof row.owner_id === "string" &&
    typeof row.owner_revision === "string" &&
    typeof row.source_revision === "string" &&
    typeof row.source_refs_json === "string" &&
    typeof row.project_id === "string" &&
    typeof row.origin_kind === "string" &&
    (typeof row.source_kind === "string" || legacyConversationRows) &&
    (typeof row.conversation_session_id === "string" || row.conversation_session_id === null) &&
    typeof row.source_observed_at === "string" &&
    Number.isFinite(Date.parse(row.source_observed_at)) &&
    typeof row._distance === "number" && Number.isFinite(row._distance);
}

export function filterCurrentGenerationVectorMatches(
  db: Database,
  generation: Pick<MemoryGenerationHandle, "generationId" | "root" | "graphPath" | "embedding">,
  matches: GenerationVectorMatches,
  scope?: GenerationVectorMembershipScope,
): GenerationVectorMatches & { partial: boolean } {
  let partial = matches.diagnostics.some((code) =>
    code.endsWith("_vector_bound_reached") ||
    code.startsWith("vector_rows_invalid=") || code.includes("_omitted="),
  );
  const filter = (
    kind: "node" | "episode",
    values: GenerationVectorMatch[],
  ) => {
    const rejectedOwners = new Set<string>();
    const currentRows = values.flatMap((match) => {
      const identityCurrent = match.generation === generation.generationId &&
        match.embeddingVersion === generation.embedding?.version &&
        match.vectorKey ===
          digest([
            "memory-vector",
            match.generation,
            kind,
            match.ownerId,
            match.ownerRevision,
            match.embeddingChunkId,
            match.embeddingVersion,
          ]);
      if (!identityCurrent) {
        rejectedOwners.add(match.ownerId);
        return [];
      }
      if (kind === "node" && scope) {
        const membership = currentNodeVectorMemberships(
          db,
          generation.generationId,
          match,
          scope,
        )[0];
        if (!membership) {
          rejectedOwners.add(match.ownerId);
          return [];
        }
        return [{
          ...match,
          sourceRevision: membership.source_revision,
          sourceRefsJson: membership.source_refs_json,
          projectId: membership.project_id,
          originKind: membership.origin_kind,
          conversationSessionId: membership.conversation_session_id,
          sourceObservedAt: membership.source_observed_at,
          sourceEpisodeId: membership.episode_id,
        }];
      }
      const expected = currentVectorReceipts(
        db,
        generation.generationId,
        kind,
        match.ownerId,
        match.ownerRevision,
        match.sourceRevision,
      );
      const current = expected.some((receipt) =>
        match.projectId === receipt.project_id &&
        match.originKind === receipt.origin_kind &&
        match.conversationSessionId === receipt.conversation_session_id &&
        normalizeIso(match.sourceObservedAt) ===
          normalizeIso(receipt.source_observed_at) &&
        match.sourceRefsJson === receipt.source_refs_json,
      );
      if (!current) rejectedOwners.add(match.ownerId);
      return current ? [match] : [];
    });
    const bestByOwner = new Map<string, GenerationVectorMatch>();
    for (const match of currentRows) {
      const prior = bestByOwner.get(match.ownerId);
      if (
        !prior || match.distance < prior.distance ||
        (match.distance === prior.distance &&
          Buffer.compare(
              Buffer.from(match.vectorKey),
              Buffer.from(prior.vectorKey),
            ) < 0)
      ) {
        bestByOwner.set(match.ownerId, match);
      }
    }
    const ranked = [...bestByOwner.values()].sort((a, b) =>
      a.distance - b.distance ||
      Buffer.compare(Buffer.from(a.ownerId), Buffer.from(b.ownerId)),
    );
    if ([...rejectedOwners].some((ownerId) => !bestByOwner.has(ownerId))) {
      partial = true;
    }
    const uniqueOwnerLimit = kind === "node" ? 64 : 128;
    if (ranked.length > uniqueOwnerLimit) partial = true;
    return ranked.slice(0, uniqueOwnerLimit).map((match, index) => ({
      ...match,
      rank: index + 1,
    }));
  };
  return {
    nodes: filter("node", matches.nodes),
    episodes: filter("episode", matches.episodes),
    diagnostics: matches.diagnostics,
    partial,
  };
}

type CurrentNodeVectorMembership = {
  episode_id: string;
  source_revision: string;
  source_refs_json: string;
  project_id: string;
  origin_kind: string;
  conversation_session_id: string | null;
  source_kind: string;
  source_observed_at: string;
};

function currentNodeVectorMemberships(
  db: Database,
  generationId: string,
  match: GenerationVectorMatch,
  scope: GenerationVectorMembershipScope,
): CurrentNodeVectorMembership[] {
  const clauses: string[] = [];
  const args: Array<string | null> = [];
  if (!scope.includeInternal) {
    clauses.push("((s.source_kind='conversation' AND s.origin_kind IN ('user_input','assistant_public')) OR s.source_kind IN ('task_report','explicit_record'))");
  }
  if (scope.scope === "current_session") {
    clauses.push("s.conversation_session_id=?");
    args.push(scope.runtimeSessionId);
  }
  if (scope.sessionIds.length) {
    clauses.push(
      `s.conversation_session_id IN (${
        scope.sessionIds.map(() => "?").join(",")
      })`,
    );
    args.push(...scope.sessionIds);
  }
  clauses.push("julianday(s.observed_at)<=julianday(?)");
  args.push(scope.asOf);
  if (scope.time?.basis === "conversation") {
    clauses.push(
      "julianday(s.observed_at)>=julianday(?)",
      "julianday(s.observed_at)<julianday(?)",
    );
    args.push(scope.time.from, scope.time.to);
  }
  if (scope.scope === "current_project") {
    clauses.push("COALESCE(c.project_id,'')=?");
    args.push(scope.runtimeProjectId ?? "");
  }
  if (scope.projectFilter === "unassigned") {
    clauses.push("c.project_id IS NULL");
  }
  if (scope.projectFilter === "selected") {
    if (!scope.projectIds.length) return [];
    clauses.push(
      `c.project_id IN (${scope.projectIds.map(() => "?").join(",")})`,
    );
    args.push(...scope.projectIds);
  }
  if (scope.sourceProjectId !== undefined) {
    clauses.push(
      scope.sourceProjectId === null
        ? "c.project_id IS NULL"
        : "(c.project_id IS NULL OR c.project_id=?)",
    );
    if (scope.sourceProjectId !== null) args.push(scope.sourceProjectId);
  }
  const event = scope.eventEpisodeEligibility?.("j.episode_id") ??
    { sql: "", args: [] };
  return db.query<CurrentNodeVectorMembership, Array<string | null>>(`
    SELECT j.episode_id,j.revision source_revision,u.source_ids_json source_refs_json,COALESCE(c.project_id,'') project_id,
      s.origin_kind,s.source_kind,s.conversation_session_id,s.observed_at source_observed_at
    FROM memory_vector_units u
    JOIN memory_projection_jobs j ON j.job_id=u.job_id AND j.generation=?
    JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
    JOIN json_each(u.source_ids_json) refs
    JOIN memory_chunk_sources s ON s.source_id=refs.value AND s.episode_id=j.episode_id AND s.revision=j.revision
    JOIN entity_mentions m ON m.entity_id=u.owner_id AND m.source_id=s.source_id AND m.episode_id=j.episode_id AND m.revision=j.revision
    WHERE u.record_kind='node' AND u.owner_id=? AND u.owner_revision=? AND u.state='complete'
      AND EXISTS(SELECT 1 FROM json_each(json_extract(u.receipt_json,'$.vector_keys')) keys WHERE keys.value=?)
      ${clauses.length ? `AND ${clauses.join(" AND ")}` : ""} ${event.sql}
    ORDER BY julianday(s.observed_at),s.source_id,j.episode_id LIMIT 256
  `).all(
    generationId,
    match.ownerId,
    match.ownerRevision,
    match.vectorKey,
    ...args,
    ...event.args,
  );
}

function currentVectorReceipts(
  db: Database,
  generationId: string,
  kind: "node" | "episode",
  ownerId: string,
  ownerRevision: string,
  sourceRevision: string,
): Array<
  {
    project_id: string;
    origin_kind: string;
    source_kind: string;
    conversation_session_id: string | null;
    source_observed_at: string;
    source_refs_json: string;
  }
> {
  return db.query<
    {
      project_id: string;
      origin_kind: string;
      source_kind: string;
      conversation_session_id: string | null;
      source_observed_at: string;
      source_refs_json: string;
    },
    any
  >(`
    SELECT COALESCE(u.project_id,'') project_id,u.origin_kind,
      (SELECT source_kind FROM memory_chunk_sources first_source WHERE first_source.episode_id=c.memory_chunk_id AND first_source.revision=c.current_revision ORDER BY first_source.source_id LIMIT 1) source_kind,
      c.conversation_session_id,
      (SELECT ordered.observed_at FROM memory_chunk_sources ordered
       WHERE ordered.episode_id=c.memory_chunk_id AND ordered.revision=c.current_revision
         AND (u.source_ids_json IS NULL OR ordered.source_id IN (SELECT value FROM json_each(u.source_ids_json)))
         AND (?='episode' OR (ordered.origin_kind=u.origin_kind AND EXISTS(SELECT 1 FROM entity_mentions own WHERE own.source_id=ordered.source_id AND own.entity_id=u.owner_id)))
       ORDER BY julianday(ordered.observed_at) DESC,ordered.source_id DESC LIMIT 1) source_observed_at,
      COALESCE(u.source_ids_json,(SELECT json_group_array(source_id) FROM (
        SELECT ordered.source_id FROM memory_chunk_sources ordered
        WHERE ordered.episode_id=c.memory_chunk_id AND ordered.revision=c.current_revision
          AND (u.source_ids_json IS NULL OR ordered.source_id IN (SELECT value FROM json_each(u.source_ids_json)))
          AND (?='episode' OR (ordered.origin_kind=u.origin_kind AND EXISTS(SELECT 1 FROM entity_mentions own WHERE own.source_id=ordered.source_id AND own.entity_id=u.owner_id)))
        ORDER BY julianday(ordered.observed_at),ordered.conversation_message_id,ordered.part_id,ordered.scalar_pointer,ordered.byte_start
      ))) source_refs_json
    FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id
    JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
    WHERE u.record_kind=? AND u.owner_id=? AND u.owner_revision=? AND j.revision=? AND j.generation=? AND u.state='complete'
    ORDER BY u.unit_id
  `).all(
    kind,
    kind,
    kind,
    ownerId,
    ownerRevision,
    sourceRevision,
    generationId,
  );
}

async function withinRecallDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("vector_deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("vector_deadline")),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function embedVectorQuantum(input: {
  generation: MemoryGenerationHandle;
  units: ClaimedVectorUnit[];
  socketPath?: string;
  expected?: GenerationEmbedding;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<
  { metadata: EmbeddingRuntimeMetadata; rows: GenerationVectorRow[] }
> {
  if (input.units.length < 1 || input.units.length > 4) {
    throw new Error("memory_vector_batch_limit");
  }
  const checked = await embedCheckedViaSocket({
    texts: input.units.map((unit) => unit.projection_text),
    expected: input.expected,
    socketPath: input.socketPath,
    resplit: true,
    maxEmbeddings: 4,
    requestClass: "background",
    deadlineAt: input.deadlineAt ?? Date.now() + 30_000,
    timeoutMs: Math.max(1, (input.deadlineAt ?? Date.now() + 30_000) - Date.now()),
    signal: input.signal,
  });
  if ((checked.omitted_count ?? 0) > 0) {
    throw new Error("memory_vector_batch_limit");
  }
  const metadata = checked.metadata;
  if (
    checked.embeddings.length !== input.units.length ||
    checked.embedded_texts?.length !== input.units.length ||
    checked.embedded_texts!.some((text, ordinal) =>
      text !== input.units[ordinal]!.projection_text
    )
  ) {
    throw new Error("memory_vector_receipt_mismatch");
  }
  const embedded = checked.embeddings.map((vector, ordinal) => ({
    unit: input.units[ordinal]!,
    text: checked.embedded_texts![ordinal]!,
    ordinal: 0,
    vector,
  }));
  if (!embedded.length) throw new Error("memory_embedding_empty");
  const rows = embedded.map((item) => {
    const identity = generationVectorIdentity({
      generationId: input.generation.generationId,
      recordKind: item.unit.record_kind,
      ownerId: item.unit.owner_id,
      ownerRevision: item.unit.owner_revision,
      embeddingText: item.text,
      ordinal: item.ordinal,
      embeddingVersion: metadata.version,
    });
    return {
      vector_key: identity.vectorKey,
      generation: input.generation.generationId,
      record_kind: item.unit.record_kind,
      owner_id: item.unit.owner_id,
      owner_revision: item.unit.owner_revision,
      source_revision: item.unit.source_revision,
      embedding_chunk_id: identity.embeddingChunkId,
      embedding_version: metadata.version,
      project_id: item.unit.project_id ?? "",
      origin_kind: item.unit.origin_kind,
      source_kind: item.unit.source_kind,
      conversation_session_id: item.unit.conversation_session_id,
      source_observed_at: normalizeIso(item.unit.source_observed_at),
      source_refs_json: item.unit.source_ids_json,
      text: "",
      vector: item.vector,
    };
  });
  return { metadata, rows };
}

function assertRecallDeadline(deadlineAt: number): void {
  if (Date.now() >= deadlineAt) throw new Error("vector_deadline");
}

function initialGraphemeChunks(text: string): string[] {
  const segments = [
    ...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text),
  ].map((item) => item.segment);
  const output: string[] = [];
  let current = "";
  for (const segment of segments) {
    if (Buffer.byteLength(current + segment) > 4096 && current) {
      output.push(current);
      current = segment;
    } else current += segment;
  }
  if (current) output.push(current);
  return output;
}

export async function writeGenerationVectorRows(
  generation: MemoryGenerationHandle,
  rows: GenerationVectorRow[],
): Promise<void> {
  if (!rows.length) throw new Error("memory_vector_rows_empty");
  const lancedb = await import("@lancedb/lancedb");
  const connection = await lancedb.connect(
    join(generation.root, "butler.lance"),
  );
  let table;
  let created = false;
  try {
    table = await connection.openTable("butler_memory");
  } catch {
    const inferableRows = rows.every(
      (row) => row.conversation_session_id === null,
    )
      ? rows.map((row) => ({ ...row, conversation_session_id: "" }))
      : rows;
    table = await connection.createTable("butler_memory", inferableRows);
    if (inferableRows !== rows) {
      await table.alterColumns([{
        path: "conversation_session_id",
        nullable: true,
      }]);
      await table.delete("conversation_session_id = ''");
      await table.add(rows);
    }
    created = true;
  }
  if (!created) {
    const fields = (await table.schema()).fields as Array<{
      name: string;
      nullable: boolean;
    }>;
    if (!fields.some((field) => field.name === "source_kind")) {
      await table.addColumns([{
        name: "source_kind",
        valueSql: "'conversation'",
      }]);
    }
    const sessionField = fields.find(
      (field) => field.name === "conversation_session_id",
    );
    if (sessionField && !sessionField.nullable) {
      await table.alterColumns([{
        path: "conversation_session_id",
        nullable: true,
      }]);
    }
    for (const row of rows) {
      await table.delete(`vector_key = ${lanceStringLiteral(row.vector_key)}`);
    }
    await table.add(rows);
  }
  const expected = new Map(rows.map((row) => [row.vector_key, row]));
  const written = await table.query().where(
    `vector_key IN (${
      rows.map((row) => lanceStringLiteral(row.vector_key)).join(",")
    })`,
  )
    .select([
      "vector_key",
      "generation",
      "record_kind",
      "owner_id",
      "owner_revision",
      "source_revision",
      "embedding_chunk_id",
      "embedding_version",
      "project_id",
      "origin_kind",
      "source_kind",
      "conversation_session_id",
      "source_observed_at",
      "source_refs_json",
    ])
    .limit(rows.length + 1).toArray() as Array<
      Omit<GenerationVectorRow, "text" | "vector">
    >;
  if (
    written.length !== rows.length || written.some((row) => {
      const wanted = expected.get(row.vector_key);
      return !wanted || row.generation !== wanted.generation ||
        row.record_kind !== wanted.record_kind ||
        row.owner_id !== wanted.owner_id ||
        row.owner_revision !== wanted.owner_revision ||
        row.source_revision !== wanted.source_revision ||
        row.embedding_chunk_id !== wanted.embedding_chunk_id ||
        row.embedding_version !== wanted.embedding_version ||
        row.project_id !== wanted.project_id ||
        row.origin_kind !== wanted.origin_kind ||
        row.conversation_session_id !== wanted.conversation_session_id ||
        row.source_observed_at !== wanted.source_observed_at ||
        row.source_refs_json !== wanted.source_refs_json;
    })
  ) throw new Error("memory_vector_receipt_mismatch");
}

export async function findPersistedVectorReceipt(
  generation: MemoryGenerationHandle,
  units: ClaimedVectorUnit[],
  embeddingVersion: string,
): Promise<
  {
    generation: string;
    embedding_version: string;
    vector_keys: string[];
    row_count: number;
  } | null
> {
  if (!units.length) return null;
  const lancedb = await import("@lancedb/lancedb");
  const connection = await lancedb.connect(
    join(generation.root, "butler.lance"),
  );
  let table;
  try {
    table = await connection.openTable("butler_memory");
  } catch {
    return null;
  }
  const fields = (await table.schema()).fields as Array<{ name: string }>;
  if (!fields.some((field) => field.name === "source_kind")) return null;
  const keys: string[] = [];
  for (const unit of units) {
    const rows = await table.query().where([
      `generation = ${lanceStringLiteral(generation.generationId)}`,
      `record_kind = ${lanceStringLiteral(unit.record_kind)}`,
      `owner_id = ${lanceStringLiteral(unit.owner_id)}`,
      `owner_revision = ${lanceStringLiteral(unit.owner_revision)}`,
      `source_revision = ${lanceStringLiteral(unit.source_revision)}`,
      `embedding_version = ${lanceStringLiteral(embeddingVersion)}`,
    ].join(" AND ")).select([
      "vector_key",
      "embedding_chunk_id",
      "project_id",
      "origin_kind",
      "source_kind",
      "conversation_session_id",
      "source_observed_at",
      "source_refs_json",
    ]).limit(2).toArray() as Array<{
      vector_key: string;
      embedding_chunk_id: string;
      project_id: string;
      origin_kind: string;
      source_kind: string;
      conversation_session_id: string | null;
      source_observed_at: string;
      source_refs_json: string;
    }>;
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    const identity = generationVectorIdentity({
      generationId: generation.generationId,
      recordKind: unit.record_kind,
      ownerId: unit.owner_id,
      ownerRevision: unit.owner_revision,
      embeddingText: unit.projection_text,
      ordinal: 0,
      embeddingVersion,
    });
    if (
      row.vector_key !== identity.vectorKey ||
      row.embedding_chunk_id !== identity.embeddingChunkId ||
      row.project_id !== (unit.project_id ?? "") ||
      row.origin_kind !== unit.origin_kind ||
      row.source_kind !== unit.source_kind ||
      row.conversation_session_id !== unit.conversation_session_id ||
      row.source_observed_at !== normalizeIso(unit.source_observed_at) ||
      row.source_refs_json !== unit.source_ids_json || !row.vector_key
    ) return null;
    keys.push(row.vector_key);
  }
  if (new Set(keys).size !== units.length) return null;
  return {
    generation: generation.generationId,
    embedding_version: embeddingVersion,
    vector_keys: keys.sort(),
    row_count: keys.length,
  };
}

type PersistedVectorReceipt = {
  generation?: string;
  embedding_version?: string;
  vector_keys?: unknown;
  row_count?: unknown;
};

export function generationVectorIdentity(
  input: {
    generationId: string;
    recordKind: "node" | "episode";
    ownerId: string;
    ownerRevision: string;
    embeddingText: string;
    ordinal: number;
    embeddingVersion: string;
  },
): { embeddingChunkId: string; vectorKey: string } {
  const embeddingChunkId = digest([
    "embedding-chunk",
    input.ownerRevision,
    input.ordinal,
    input.embeddingText,
  ]);
  return {
    embeddingChunkId,
    vectorKey: digest([
      "memory-vector",
      input.generationId,
      input.recordKind,
      input.ownerId,
      input.ownerRevision,
      embeddingChunkId,
      input.embeddingVersion,
    ]),
  };
}

function completedVectorReceiptKeys(
  unit: ClaimedVectorUnit,
  generationId: string,
  embeddingVersion: string,
): Set<string> | null {
  let receipt: PersistedVectorReceipt | null;
  try {
    receipt = JSON.parse(unit.receipt_json ?? "null") as PersistedVectorReceipt | null;
  } catch {
    return null;
  }
  if (
    !receipt ||
    receipt.generation !== generationId ||
    receipt.embedding_version !== embeddingVersion ||
    !Array.isArray(receipt.vector_keys) ||
    receipt.vector_keys.some((key) => typeof key !== "string" || !key) ||
    !Number.isInteger(receipt.row_count)
  ) return null;
  const keys = new Set(receipt.vector_keys as string[]);
  return receipt.row_count === keys.size ? keys : null;
}

function completedVectorReceiptHasExpectedIdentity(
  unit: ClaimedVectorUnit,
  generationId: string,
  embeddingVersion: string,
): boolean {
  const identity = generationVectorIdentity({
    generationId,
    recordKind: unit.record_kind,
    ownerId: unit.owner_id,
    ownerRevision: unit.owner_revision,
    embeddingText: unit.projection_text,
    ordinal: 0,
    embeddingVersion,
  });
  return completedVectorReceiptKeys(unit, generationId, embeddingVersion)
    ?.has(identity.vectorKey) === true;
}

export function completedVectorReceiptLacksExpectedIdentity(
  unit: ClaimedVectorUnit,
  generationId: string,
  embeddingVersion: string,
): boolean {
  const identity = generationVectorIdentity({
    generationId,
    recordKind: unit.record_kind,
    ownerId: unit.owner_id,
    ownerRevision: unit.owner_revision,
    embeddingText: unit.projection_text,
    ordinal: 0,
    embeddingVersion,
  });
  const keys = completedVectorReceiptKeys(unit, generationId, embeddingVersion);
  return keys !== null && !keys.has(identity.vectorKey);
}

type PersistedVectorMetadata = Omit<GenerationVectorRow, "text" | "vector">;

async function persistedVectorMetadataByKey(
  generation: MemoryGenerationHandle,
  physicalKeys: Set<string>,
): Promise<Map<string, PersistedVectorMetadata[]>> {
  const rowsByKey = new Map<string, PersistedVectorMetadata[]>();
  if (!physicalKeys.size) return rowsByKey;
  const lancedb = await import("@lancedb/lancedb");
  const connection = await lancedb.connect(join(generation.root, "butler.lance"));
  let table: import("@lancedb/lancedb").Table | null = null;
  try {
    table = await connection.openTable("butler_memory");
    const rows = await table.query().where(
      `vector_key IN (${[...physicalKeys].map(lanceStringLiteral).join(",")})`,
    ).select([
      "vector_key",
      "generation",
      "record_kind",
      "owner_id",
      "owner_revision",
      "source_revision",
      "embedding_chunk_id",
      "embedding_version",
      "project_id",
      "origin_kind",
      "source_kind",
      "conversation_session_id",
      "source_observed_at",
      "source_refs_json",
    ]).limit(physicalKeys.size + 1).toArray() as PersistedVectorMetadata[];
    for (const row of rows) {
      const values = rowsByKey.get(row.vector_key) ?? [];
      values.push(row);
      rowsByKey.set(row.vector_key, values);
    }
    return rowsByKey;
  } finally {
    try {
      table?.close();
    } finally {
      connection.close();
    }
  }
}

function vectorStableIdentityMatches(
  row: PersistedVectorMetadata,
  generation: MemoryGenerationHandle,
  unit: ClaimedVectorUnit,
  identity: { vectorKey: string; embeddingChunkId: string },
  embeddingVersion: string,
): boolean {
  return row.vector_key === identity.vectorKey &&
    row.generation === generation.generationId &&
    row.record_kind === unit.record_kind &&
    row.owner_id === unit.owner_id &&
    row.owner_revision === unit.owner_revision &&
    row.embedding_chunk_id === identity.embeddingChunkId &&
    row.embedding_version === embeddingVersion &&
    row.project_id === (unit.project_id ?? "") &&
    row.origin_kind === unit.origin_kind;
}

function vectorMembershipMatches(row: PersistedVectorMetadata, unit: ClaimedVectorUnit): boolean {
  return row.source_revision === unit.source_revision &&
    row.source_kind === unit.source_kind &&
    row.conversation_session_id === unit.conversation_session_id &&
    row.source_observed_at === normalizeIso(unit.source_observed_at) &&
    row.source_refs_json === unit.source_ids_json;
}

function validVectorUnitEvidence(
  unit: ClaimedVectorUnit,
  generationId: string,
  embeddingVersion: string,
  vectorKey: string,
): boolean {
  let sourceRefs: unknown;
  try {
    sourceRefs = JSON.parse(unit.source_ids_json);
    normalizeIso(unit.source_observed_at);
  } catch {
    return false;
  }
  return Array.isArray(sourceRefs) && sourceRefs.length > 0 &&
    sourceRefs.every((ref) => typeof ref === "string" && Boolean(ref)) &&
    completedVectorReceiptKeys(unit, generationId, embeddingVersion)?.has(vectorKey) === true;
}

export type VectorRepresentativeReconciliation = {
  repaired_vector_keys: string[];
  affected_unit_ids: string[];
};

export async function reconcilePersistedNodeVectorRepresentatives(
  generation: MemoryGenerationHandle,
  currentCompleteUnits: ClaimedVectorUnit[],
  supersededUnits: ClaimedVectorUnit[],
  embeddingVersion: string,
): Promise<VectorRepresentativeReconciliation> {
  const empty = (): VectorRepresentativeReconciliation => ({ repaired_vector_keys: [], affected_unit_ids: [] });
  const currentGroups = new Map<string, { identity: { vectorKey: string; embeddingChunkId: string }; units: ClaimedVectorUnit[] }>();
  for (const unit of currentCompleteUnits) {
    if (unit.record_kind !== "node") continue;
    const identity = generationVectorIdentity({
      generationId: generation.generationId, recordKind: unit.record_kind,
      ownerId: unit.owner_id, ownerRevision: unit.owner_revision,
      embeddingText: unit.projection_text, ordinal: 0, embeddingVersion,
    });
    if (!validVectorUnitEvidence(unit, generation.generationId, embeddingVersion, identity.vectorKey)) continue;
    const group = currentGroups.get(identity.vectorKey) ?? { identity, units: [] };
    group.units.push(unit);
    currentGroups.set(identity.vectorKey, group);
  }
  if (!currentGroups.size) return empty();
  const supersededByKey = new Map<string, ClaimedVectorUnit[]>();
  for (const unit of supersededUnits) {
    if (unit.record_kind !== "node") continue;
    const identity = generationVectorIdentity({
      generationId: generation.generationId, recordKind: unit.record_kind,
      ownerId: unit.owner_id, ownerRevision: unit.owner_revision,
      embeddingText: unit.projection_text, ordinal: 0, embeddingVersion,
    });
    if (!validVectorUnitEvidence(unit, generation.generationId, embeddingVersion, identity.vectorKey)) continue;
    const values = supersededByKey.get(identity.vectorKey) ?? [];
    values.push(unit);
    supersededByKey.set(identity.vectorKey, values);
  }
  if (!supersededByKey.size) return empty();
  const repairableKeys = new Set([...currentGroups.keys()].filter((key) => supersededByKey.has(key)));
  if (!repairableKeys.size) return empty();
  let rowsByKey: Map<string, PersistedVectorMetadata[]>;
  try {
    rowsByKey = await persistedVectorMetadataByKey(generation, repairableKeys);
  } catch {
    return empty();
  }
  const representatives: ClaimedVectorUnit[] = [];
  const affected = new Map<string, string[]>();
  for (const [vectorKey, group] of currentGroups) {
    if (!repairableKeys.has(vectorKey)) continue;
    const physical = rowsByKey.get(vectorKey) ?? [];
    if (physical.length !== 1) continue;
    const row = physical[0]!;
    const candidates = group.units.filter((unit) =>
      vectorStableIdentityMatches(row, generation, unit, group.identity, embeddingVersion));
    if (!candidates.length || candidates.some((unit) => vectorMembershipMatches(row, unit))) continue;
    const stale = (supersededByKey.get(vectorKey) ?? []).some((unit) =>
      vectorStableIdentityMatches(row, generation, unit, group.identity, embeddingVersion) &&
      vectorMembershipMatches(row, unit));
    if (!stale) continue;
    candidates.sort((a, b) => a.unit_id.localeCompare(b.unit_id));
    representatives.push(candidates[0]!);
    affected.set(vectorKey, candidates.map((unit) => unit.unit_id).sort());
  }
  if (!representatives.length) return empty();
  const reused = await prepareReusedGenerationVectorRows(generation, representatives, embeddingVersion);
  if (!reused || reused.length !== representatives.length) return empty();
  await writeGenerationVectorRows(generation, reused);
  const repaired = reused.map((row) => row.vector_key).sort();
  return {
    repaired_vector_keys: repaired,
    affected_unit_ids: repaired.flatMap((key) => affected.get(key) ?? []),
  };
}

/**
 * Verifies completed storage without treating a serialized batch receipt as an
 * operation identity. Node payloads are shared by their stable vector key;
 * their current source memberships remain authoritative in the graph store.
 */
export async function countInvalidPersistedVectorReadiness(
  generation: MemoryGenerationHandle,
  units: ClaimedVectorUnit[],
  embeddingVersion: string,
): Promise<number> {
  if (!units.length) return 0;
  const invalid = new Set<string>();
  const nodeGroups = new Map<string, {
    embeddingChunkId: string;
    units: ClaimedVectorUnit[];
  }>();
  const episodeUnits: Array<{
    embeddingChunkId: string;
    vectorKey: string;
    unit: ClaimedVectorUnit;
  }> = [];

  for (const unit of units) {
    const identity = generationVectorIdentity({
      generationId: generation.generationId,
      recordKind: unit.record_kind,
      ownerId: unit.owner_id,
      ownerRevision: unit.owner_revision,
      embeddingText: unit.projection_text,
      ordinal: 0,
      embeddingVersion,
    });
    const receiptKeys = completedVectorReceiptKeys(
      unit,
      generation.generationId,
      embeddingVersion,
    );
    if (!receiptKeys || !receiptKeys.has(identity.vectorKey)) {
      invalid.add(unit.unit_id);
    }
    if (unit.record_kind === "episode") {
      episodeUnits.push({ ...identity, unit });
      continue;
    }
    const group = nodeGroups.get(identity.vectorKey) ?? {
      embeddingChunkId: identity.embeddingChunkId,
      units: [],
    };
    group.units.push(unit);
    nodeGroups.set(identity.vectorKey, group);
  }

  const physicalKeys = new Set([
    ...nodeGroups.keys(),
    ...episodeUnits.map((entry) => entry.vectorKey),
  ]);
  try {
    const rowsByKey = await persistedVectorMetadataByKey(generation, physicalKeys);
    for (const [vectorKey, group] of nodeGroups) {
      const physical = rowsByKey.get(vectorKey) ?? [];
      const row = physical[0];
      const first = group.units[0]!;
      const stableIdentityMatches = physical.length === 1 && row &&
        vectorStableIdentityMatches(row, generation, first, {
          vectorKey, embeddingChunkId: group.embeddingChunkId,
        }, embeddingVersion);
      const representativeIsCurrent = stableIdentityMatches && group.units.some((unit) =>
        vectorMembershipMatches(row, unit)
      );
      if (!stableIdentityMatches || !representativeIsCurrent) {
        for (const unit of group.units) invalid.add(unit.unit_id);
      }
    }
    for (const { vectorKey, embeddingChunkId, unit } of episodeUnits) {
      const physical = rowsByKey.get(vectorKey) ?? [];
      const row = physical[0];
      if (
        physical.length !== 1 || !row ||
        row.vector_key !== vectorKey ||
        row.generation !== generation.generationId ||
        row.record_kind !== "episode" ||
        row.owner_id !== unit.owner_id ||
        row.owner_revision !== unit.owner_revision ||
        row.source_revision !== unit.source_revision ||
        row.embedding_chunk_id !== embeddingChunkId ||
        row.embedding_version !== embeddingVersion ||
        row.project_id !== (unit.project_id ?? "") ||
        row.origin_kind !== unit.origin_kind ||
        row.source_kind !== unit.source_kind ||
        row.conversation_session_id !== unit.conversation_session_id ||
        row.source_observed_at !== normalizeIso(unit.source_observed_at) ||
        row.source_refs_json !== unit.source_ids_json
      ) invalid.add(unit.unit_id);
    }
  } catch {
    for (const group of nodeGroups.values()) {
      for (const unit of group.units) invalid.add(unit.unit_id);
    }
    for (const { unit } of episodeUnits) invalid.add(unit.unit_id);
  }
  return invalid.size;
}

export async function prepareReusedGenerationVectorRows(
  generation: MemoryGenerationHandle,
  units: ClaimedVectorUnit[],
  embeddingVersion: string,
): Promise<GenerationVectorRow[] | null> {
  if (
    !units.length ||
    units.some((unit) => unit.record_kind !== "node" || !unit.receipt_json)
  ) return null;
  const receiptKeys = new Set<string>();
  for (const unit of units) {
    const identity = generationVectorIdentity({
      generationId: generation.generationId,
      recordKind: unit.record_kind,
      ownerId: unit.owner_id,
      ownerRevision: unit.owner_revision,
      embeddingText: unit.projection_text,
      ordinal: 0,
      embeddingVersion,
    });
    if (!completedVectorReceiptHasExpectedIdentity(
      unit,
      generation.generationId,
      embeddingVersion,
    )) return null;
    receiptKeys.add(identity.vectorKey);
  }
  if (!receiptKeys.size) return null;
  const lancedb = await import("@lancedb/lancedb");
  const connection = await lancedb.connect(
    join(generation.root, "butler.lance"),
  );
  let table;
  try {
    table = await connection.openTable("butler_memory");
  } catch {
    return null;
  }
  const persisted = await table.query().where(
    `vector_key IN (${[...receiptKeys].map(lanceStringLiteral).join(",")})`,
  )
    .select([
      "vector_key",
      "generation",
      "record_kind",
      "owner_id",
      "owner_revision",
      "embedding_chunk_id",
      "embedding_version",
      "vector",
    ])
    .limit(receiptKeys.size + 1).toArray() as Array<
      Pick<
        GenerationVectorRow,
        | "vector_key"
        | "generation"
        | "record_kind"
        | "owner_id"
        | "owner_revision"
        | "embedding_chunk_id"
        | "embedding_version"
        | "vector"
      >
    >;
  const rows: GenerationVectorRow[] = [];
  for (const unit of units) {
    const identity = generationVectorIdentity({
      generationId: generation.generationId,
      recordKind: unit.record_kind,
      ownerId: unit.owner_id,
      ownerRevision: unit.owner_revision,
      embeddingText: unit.projection_text,
      ordinal: 0,
      embeddingVersion,
    });
    const row = persisted.find((candidate) =>
      candidate.vector_key === identity.vectorKey &&
      candidate.generation === generation.generationId &&
      candidate.record_kind === unit.record_kind &&
      candidate.owner_id === unit.owner_id &&
      candidate.owner_revision === unit.owner_revision &&
      candidate.embedding_chunk_id === identity.embeddingChunkId &&
      candidate.embedding_version === embeddingVersion,
    );
    if (
      !row || !Array.from(row.vector).length ||
      Array.from(row.vector).some((value) => !Number.isFinite(value))
    ) return null;
    rows.push({
      vector_key: row.vector_key,
      generation: row.generation,
      record_kind: row.record_kind,
      owner_id: row.owner_id,
      owner_revision: row.owner_revision,
      source_revision: unit.source_revision,
      embedding_chunk_id: row.embedding_chunk_id,
      embedding_version: row.embedding_version,
      project_id: unit.project_id ?? "",
      origin_kind: unit.origin_kind,
      source_kind: unit.source_kind,
      conversation_session_id: unit.conversation_session_id,
      source_observed_at: normalizeIso(unit.source_observed_at),
      source_refs_json: unit.source_ids_json,
      text: "",
      vector: Array.from(row.vector),
    });
  }
  return rows;
}

function digest(value: unknown[]): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest(
    "hex",
  );
}
function normalizeIso(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new Error("memory_vector_source_time_invalid");
  }
  return new Date(time).toISOString();
}
function uniqueNfc(values: string[]): string[] {
  const seen = new Set<string>();
  return values.map((value) => value.trim()).filter((value) => {
    const key = value.normalize("NFC");
    return Boolean(value) && !seen.has(key) && Boolean(seen.add(key));
  });
}

export async function searchVectorEpisodes(input: {
  butlerData: string;
  query: string;
  projectId?: string;
  limit?: number;
  timeoutMs?: number;
  backend?: VectorEpisodeBackend;
}): Promise<VectorEpisodeSearchResult> {
  const query = input.query.trim();
  if (!query) {
    return { candidates: [], diagnostics: ["vector=skipped:empty-query"] };
  }
  const limit = Math.max(
    VECTOR_SEARCH_MIN_LIMIT,
    Math.min(
      VECTOR_SEARCH_MAX_LIMIT,
      Math.trunc(input.limit ?? VECTOR_SEARCH_DEFAULT_LIMIT),
    ),
  );
  const timeoutMs = Math.max(
    VECTOR_SEARCH_MIN_TIMEOUT_MS,
    Math.min(
      VECTOR_SEARCH_MAX_TIMEOUT_MS,
      Math.trunc(input.timeoutMs ?? VECTOR_SEARCH_DEFAULT_TIMEOUT_MS),
    ),
  );
  const startedAt = Date.now();
  const dbPath = join(
    cognitionMemoryRoot(input.butlerData),
    "db",
    "butler.lance",
  );
  const tableName = "butler_memory";
  const backend = input.backend ?? defaultVectorEpisodeBackend;
  const projectId = input.projectId?.trim() || undefined;
  if (!input.backend && !existsSync(dbPath)) {
    return {
      candidates: [],
      diagnostics: ["vector=unavailable:lancedb-missing"],
    };
  }
  const circuitState = vectorCircuitState(backend);
  if (circuitState.openUntil > Date.now()) {
    return {
      candidates: [],
      diagnostics: [
        "vector=unavailable:circuit-open",
        `vector_circuit_failures=${circuitState.failureCount}`,
      ],
    };
  }

  let vector: number[] | null;
  try {
    const embedResult = await withTimeout(
      () => backend.embed(query, timeoutMs),
      timeoutMs,
    );
    if (embedResult.status === "timeout") {
      recordVectorCircuitFailure(backend);
      return {
        candidates: [],
        diagnostics: ["vector=unavailable:embed-timeout"],
      };
    }
    vector = embedResult.value;
  } catch {
    recordVectorCircuitFailure(backend);
    return { candidates: [], diagnostics: ["vector=unavailable:embed-failed"] };
  }
  if (!vector || vector.length === 0) {
    recordVectorCircuitFailure(backend);
    return { candidates: [], diagnostics: ["vector=unavailable:embed-empty"] };
  }

  const remainingMs = remainingBudgetMs(startedAt, timeoutMs);
  if (remainingMs <= 0) {
    recordVectorCircuitFailure(backend);
    return {
      candidates: [],
      diagnostics: ["vector=unavailable:query-timeout"],
    };
  }
  const canPrefilterProject = Boolean(
    projectId && backend.supportsProjectFilter,
  );
  const fallbackLimit = projectId ? overfetchLimit(limit) : limit;
  const searchLimit = canPrefilterProject ? limit : fallbackLimit;
  let rows: VectorEpisodeRow[];
  let actualProjectFilterMode: VectorProjectFilterMode = projectId
    ? (canPrefilterProject ? "prefilter" : "postfilter")
    : "none";
  let actualSearchLimit = searchLimit;
  try {
    const searchResult = await withTimeout(
      () =>
        backend.search({
          dbPath,
          tableName,
          vector,
          limit: searchLimit,
          fallbackLimit,
          projectId: canPrefilterProject ? projectId : undefined,
        }),
      remainingMs,
    );
    if (searchResult.status === "timeout") {
      recordVectorCircuitFailure(backend);
      return {
        candidates: [],
        diagnostics: ["vector=unavailable:query-timeout"],
      };
    }
    const normalizedSearch = normalizeVectorSearchRows(searchResult.value);
    rows = normalizedSearch.rows;
    actualProjectFilterMode = normalizedSearch.projectFilterMode ??
      actualProjectFilterMode;
    actualSearchLimit = normalizedSearch.limit ?? actualSearchLimit;
  } catch {
    recordVectorCircuitFailure(backend);
    return { candidates: [], diagnostics: ["vector=unavailable:query-failed"] };
  }
  recordVectorCircuitSuccess(backend);
  const filteredRows = projectId
    ? rows.filter((row) => row.project === projectId)
    : rows;
  const selectedRows = filteredRows.slice(0, limit);
  const candidates = vectorRowsToRecallCandidates(selectedRows);
  const rowsWithoutScore =
    selectedRows.filter((row) => vectorSimilarity(row) === undefined).length;
  return {
    candidates,
    diagnostics: [
      "vector=ok",
      `vector_rows=${rows.length}`,
      `vector_project_filter=${actualProjectFilterMode}`,
      `vector_search_limit=${actualSearchLimit}`,
      `vector_rows_without_score=${rowsWithoutScore}`,
      `vector_candidates=${candidates.length}`,
    ],
  };
}

export function vectorRowsToRecallCandidates(
  rows: VectorEpisodeRow[],
): RecallCandidate[] {
  return rows.flatMap((row, index) => {
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text) return [];
    const rowId = typeof row.id === "string" && row.id.trim()
      ? row.id.trim()
      : `row_${index + 1}`;
    const sessionId =
      typeof row.session_id === "string" && row.session_id.trim()
        ? row.session_id.trim()
        : "unknown-session";
    const similarity = vectorSimilarity(row);
    return [{
      id: `vector:${rowId}`,
      summary: compact(text, VECTOR_CANDIDATE_SUMMARY_CHARS),
      text,
      source: "vector",
      provenance: [`vector:${sessionId}:${rowId}`],
      timestamp: typeof row.timestamp === "number" ? row.timestamp : undefined,
      frequency: 1,
      ...(similarity === undefined ? {} : { vectorSimilarity: similarity }),
    }];
  });
}

function vectorSimilarity(row: VectorEpisodeRow): number | undefined {
  if (typeof row._score === "number" && Number.isFinite(row._score)) {
    return clamp01(row._score);
  }
  if (typeof row._distance === "number" && Number.isFinite(row._distance)) {
    return clamp01(1 / (1 + Math.max(0, row._distance)));
  }
  return undefined;
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit
    ? `${normalized.slice(0, limit)}...`
    : normalized;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function createLanceDbMemoryVectorBackend(input?: {
  embed?: VectorEpisodeBackend["embed"];
}): VectorEpisodeBackend {
  return {
    supportsProjectFilter: true,
    async embed(query, timeoutMs) {
      if (input?.embed) return await input.embed(query, timeoutMs);
      return await embedViaSocket(query, undefined, timeoutMs);
    },
    async search(input) {
      const lancedb = await import("@lancedb/lancedb");
      const db = await lancedb.connect(input.dbPath);
      const table = await db.openTable(input.tableName);
      const search = table.search(input.vector) as LanceDbSearchBuilder;
      if (input.projectId && typeof search.where === "function") {
        const rows = await search
          .where(`project = ${lanceStringLiteral(input.projectId)}`)
          .limit(input.limit)
          .toArray() as VectorEpisodeRow[];
        return {
          rows,
          projectFilterMode: "prefilter",
          limit: input.limit,
        };
      }
      const fallbackLimit = input.fallbackLimit ?? input.limit;
      const rows = await search
        .limit(input.fallbackLimit ?? input.limit)
        .toArray() as VectorEpisodeRow[];
      return {
        rows,
        projectFilterMode: input.projectId ? "postfilter" : "none",
        limit: fallbackLimit,
      };
    },
  };
}

type LanceDbSearchBuilder = {
  where?: (clause: string) => LanceDbSearchBuilder;
  limit: (limit: number) => { toArray: () => Promise<unknown[]> };
};

type TimedResult<T> =
  | { status: "ok"; value: T }
  | { status: "timeout" };

const defaultVectorEpisodeBackend = createLanceDbMemoryVectorBackend();
const vectorCircuitStates = new WeakMap<VectorEpisodeBackend, {
  failureCount: number;
  openUntil: number;
}>();

function overfetchLimit(limit: number): number {
  return Math.max(
    limit,
    Math.min(
      VECTOR_SEARCH_OVERFETCH_MAX_LIMIT,
      limit * VECTOR_SEARCH_OVERFETCH_MULTIPLIER,
    ),
  );
}

function normalizeVectorSearchRows(value: VectorEpisodeSearchRows): {
  rows: VectorEpisodeRow[];
  projectFilterMode?: VectorProjectFilterMode;
  limit?: number;
} {
  if (Array.isArray(value)) return { rows: value };
  return {
    rows: Array.isArray(value.rows) ? value.rows : [],
    projectFilterMode: value.projectFilterMode,
    limit: typeof value.limit === "number" && Number.isFinite(value.limit)
      ? value.limit
      : undefined,
  };
}

function remainingBudgetMs(startedAt: number, timeoutMs: number): number {
  return Math.max(0, timeoutMs - (Date.now() - startedAt));
}

function vectorCircuitState(backend: VectorEpisodeBackend): {
  failureCount: number;
  openUntil: number;
} {
  const state = vectorCircuitStates.get(backend);
  if (state) return state;
  const fresh = { failureCount: 0, openUntil: 0 };
  vectorCircuitStates.set(backend, fresh);
  return fresh;
}

function recordVectorCircuitSuccess(backend: VectorEpisodeBackend): void {
  const state = vectorCircuitState(backend);
  state.failureCount = 0;
  state.openUntil = 0;
}

function recordVectorCircuitFailure(backend: VectorEpisodeBackend): void {
  const state = vectorCircuitState(backend);
  state.failureCount += 1;
  if (state.failureCount >= VECTOR_CIRCUIT_FAILURE_THRESHOLD) {
    state.openUntil = Date.now() + VECTOR_CIRCUIT_COOLDOWN_MS;
  }
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<TimedResult<T>> {
  if (timeoutMs <= 0) return { status: "timeout" };
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const running = Promise.resolve().then(operation);
  running.catch(() => undefined);
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const result = await Promise.race([running, timeout]);
    if (result === "timeout") {
      return { status: "timeout" };
    }
    return { status: "ok", value: result };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function lanceStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
