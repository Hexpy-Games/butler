import { sourceQueryTerms } from "../projection/source-index.ts";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { conversationStorePath } from "../../../conversation/store.ts";
import { foldedGraphemeNgrams, unicodeCaseFold, unicodeNfc } from "../projection/unicode.ts";
import type { RecallMemoryInput, SeedCandidate } from "./contracts.ts";

const MAX_CHANNEL_CANDIDATES = 64;

export type SemanticSeedSelection = {
  seeds: string[];
  allSeeds: string[];
  channels: Map<string, Set<string>>;
  ranks: Map<string, Map<SeedCandidate["channel"], number>>;
  scores: Map<string, Map<SeedCandidate["channel"], number>>;
  contextSourceIds: Set<string>;
  coverageCodes: string[];
};

export function selectSemanticSeeds(
  db: Database,
  input: RecallMemoryInput,
  vectorNodes: Array<{ ownerId: string; rank: number; distance: number }> = [],
  deadlineAt = Number.POSITIVE_INFINITY,
  maxSeeds = 16,
  sourceScope?: { projectId: string | null },
): SemanticSeedSelection {
  const admitted = input.admittedChannels ?? {
    graph: true,
    lexical: true,
    vector: true,
    context: true,
    explicit: true,
    task: true,
  };
  const phrases = uniqueOriginalByNfc([input.cue, ...(input.seedPhrases ?? [])]);
  const aliases = admitted.graph || admitted.lexical || admitted.explicit
    ? aliasCandidates(db, input, phrases, sourceScope)
    : [];
  const lexicalResult = admitted.lexical || admitted.explicit
    ? lexicalCandidates(db, input, input.cue, deadlineAt, sourceScope)
    : { candidates: [], partial: false };
  const contextSelection = admitted.context
    ? contextCandidates(db, input, sourceScope)
    : { candidates: [], sourceIds: new Set<string>() };
  const context = contextSelection.candidates;
  const eligibleVectorNodes = admitted.vector
    ? eligibleVectorNodeIds(
      db,
      input,
      vectorNodes.map((item) => item.ownerId),
      sourceScope,
    )
    : new Set<string>();
  const vectors = vectorNodes.filter((item) => eligibleVectorNodes.has(item.ownerId)).slice(0, MAX_CHANNEL_CANDIDATES).map((item) => ({
    nodeId: item.ownerId,
    channel: "vector" as const,
    rank: item.rank,
    score: 1 / (1 + Math.max(0, item.distance)),
  }));
  const byNode = new Map<string, Map<SeedCandidate["channel"], SeedCandidate>>();
  const contextOnly = !admitted.graph && !admitted.lexical && !admitted.vector && !admitted.explicit;
  for (const candidate of [...aliases, ...lexicalResult.candidates, ...vectors, ...context]) {
    if (candidate.channel === "context" && !contextOnly && !byNode.has(candidate.nodeId)) continue;
    const channels = byNode.get(candidate.nodeId) ?? new Map();
    const prior = channels.get(candidate.channel);
    if (!prior || candidate.rank < prior.rank || (candidate.rank === prior.rank && candidate.score > prior.score)) channels.set(candidate.channel, candidate);
    byNode.set(candidate.nodeId, channels);
  }
  // Recent messages can disambiguate query matches; they cannot occupy the
  // seed slots solely because they happen to be in the caller's last turn.
  const semantic = [...byNode.entries()].map(([nodeId, channels]) => ({
    nodeId,
    score: contextOnly ? 1 / (60 + (channels.get("context")?.rank ?? 1)) : seedFusionScore(channels),
    contextRank: channels.get("context")?.rank ?? Number.POSITIVE_INFINITY,
  })).sort((a, b) => b.score - a.score || a.contextRank - b.contextRank || compareUtf8(a.nodeId, b.nodeId));
  const allSeeds = semantic.map((item) => item.nodeId).slice(0, maxSeeds);
  const seeds = allSeeds.slice(0, input.time ? 8 : maxSeeds);
  return {
    seeds,
    allSeeds,
    channels: new Map([...byNode].map(([nodeId, values]) => [nodeId, new Set(values.keys())])),
    ranks: new Map([...byNode].map(([nodeId, values]) => [nodeId, new Map([...values].map(([channel, value]) => [channel, value.rank]))])),
    scores: new Map([...byNode].map(([nodeId, values]) => [nodeId, new Map([...values].map(([channel, value]) => [channel, value.score]))])),
    contextSourceIds: contextSelection.sourceIds,
    coverageCodes: lexicalResult.partial ? ["lexical_partial"] : [],
  };
}

export function selectTemporalSeeds(db: Database, input: RecallMemoryInput): { seeds: string[]; episodeIds: string[] } {
  if (!input.time) return { seeds: [], episodeIds: [] };
  const fromMs = Date.parse(input.time.from), toMs = Date.parse(input.time.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return { seeds: [], episodeIds: [] };
  if (input.time.basis === "event") return selectEventTemporalSeeds(db, input);
  const duration = Math.max(1, toMs - fromMs);
  const bins = Math.min(8, Math.max(1, Math.floor(duration)));
  const validity = claimEligibility(input);
  const selectedValidity = claimEligibility(input, "e2");
  const rows = db.query<{ episode_id: string; node_id: string | null }, any>(`
    WITH source_episodes AS (
      SELECT c.memory_chunk_id episode_id,
        CASE WHEN s.source_kind='conversation' THEN 'conversation:'||c.conversation_session_id
             ELSE s.source_kind||':'||c.memory_chunk_id END session_id,
        strftime('%Y-%m-%dT%H:%M:%fZ',MAX(julianday(s.observed_at))) basis_time,
        MAX(CASE (SELECT salience FROM memory_claims WHERE node_id=e.id) WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END) salience
      FROM memory_chunks c JOIN memory_chunk_sources s ON s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision
      LEFT JOIN memory_evidence m ON m.source_id=s.source_id AND m.revision=c.current_revision LEFT JOIN memory_nodes e ON e.id=m.node_id
        AND e.type IN ('preference','goal','constraint','decision','memory_atom')
      WHERE ${scopeSql(input)} GROUP BY c.memory_chunk_id
      HAVING COUNT(DISTINCT e.id)=0 OR COUNT(DISTINCT CASE WHEN ${validity.sql} THEN e.id END)>0
    ), eligible AS (
      SELECT *,MIN(?-1,MAX(0,CAST((((julianday(basis_time)-2440587.5)*86400000)-?)*?/? AS INTEGER))) bin FROM source_episodes
    ), per_session AS (
      SELECT *,ROW_NUMBER() OVER(PARTITION BY bin,session_id ORDER BY salience DESC,basis_time DESC,episode_id) session_rank FROM eligible
    ), session_heads AS (
      SELECT bin,session_id,salience,basis_time,episode_id,
        ROW_NUMBER() OVER(PARTITION BY bin ORDER BY salience DESC,basis_time DESC,episode_id,session_id) session_order
      FROM per_session WHERE session_rank=1
    ), bin_queue AS (
      SELECT p.*,h.session_order,ROW_NUMBER() OVER(PARTITION BY p.bin ORDER BY p.session_rank,h.session_order) bin_position
      FROM per_session p JOIN session_heads h ON h.bin=p.bin AND h.session_id=p.session_id
    )
      SELECT q.episode_id,(SELECT m2.node_id FROM memory_evidence m2 JOIN memory_nodes e2 ON e2.id=m2.node_id
      JOIN memory_chunk_sources s2 ON s2.source_id=m2.source_id
      JOIN memory_chunks c2 ON c2.memory_chunk_id=s2.episode_id AND c2.current_revision=s2.revision
      WHERE m2.episode_id=q.episode_id AND e2.type!='project' AND ${selectedValidity.sql} AND ${scopeSql(input, undefined, "s2", "c2")}
      ORDER BY CASE WHEN e2.type IN ('preference','goal','constraint','decision','memory_atom') THEN 0 ELSE 1 END,
        CASE (SELECT salience FROM memory_claims WHERE node_id=e2.id) WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        s2.observed_at DESC,m2.node_id LIMIT 1) node_id
    FROM bin_queue q WHERE q.bin_position<=8 ORDER BY q.bin_position,q.bin LIMIT 64
  `).all(...scopeArgs(input), ...validity.args, bins, fromMs, bins, duration, ...selectedValidity.args, ...scopeArgs(input));
  return temporalRows(rows);
}

function selectEventTemporalSeeds(db: Database, input: RecallMemoryInput): { seeds: string[]; episodeIds: string[] } {
  const fromMs = Date.parse(input.time!.from), toMs = Date.parse(input.time!.to), duration = Math.max(1, toMs - fromMs);
  const bins = Math.min(8, Math.max(1, Math.floor(duration)));
  const scoped = { ...input, time: undefined };
  const rows = db.query<{ episode_id: string; node_id: string | null }, any>(`
    WITH event_claims AS (
      SELECT m.episode_id,
        CASE WHEN s.source_kind='conversation' THEN 'conversation:'||c.conversation_session_id
             ELSE s.source_kind||':'||c.memory_chunk_id END session_id,m.node_id,
        (SELECT valid_from FROM memory_claims WHERE node_id=e.id) basis_time,
        CASE (SELECT salience FROM memory_claims WHERE node_id=e.id) WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END salience,
        MIN(?-1,MAX(0,CAST((MAX(0,((julianday((SELECT valid_from FROM memory_claims WHERE node_id=e.id))-2440587.5)*86400000)-?))*?/? AS INTEGER))) bin
      FROM memory_evidence m JOIN memory_nodes e ON e.id=m.node_id JOIN memory_chunk_sources s ON s.source_id=m.source_id
      JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
      WHERE e.type IN ('preference','goal','constraint','decision','memory_atom') AND (SELECT valid_from FROM memory_claims WHERE node_id=e.id) IS NOT NULL
        AND julianday((SELECT valid_from FROM memory_claims WHERE node_id=e.id))<julianday(?)
        AND julianday(COALESCE((SELECT valid_to FROM memory_claims WHERE node_id=e.id),?))>julianday(?)
        AND ${scopeSql(scoped)}
    ), episodes AS (
      SELECT episode_id,session_id,bin,MAX(basis_time) basis_time,MAX(salience) salience FROM event_claims GROUP BY episode_id
    ), per_session AS (
      SELECT *,ROW_NUMBER() OVER(PARTITION BY bin,session_id ORDER BY salience DESC,basis_time DESC,episode_id) session_rank FROM episodes
    ), session_heads AS (
      SELECT bin,session_id,ROW_NUMBER() OVER(PARTITION BY bin ORDER BY salience DESC,basis_time DESC,episode_id,session_id) session_order
      FROM per_session WHERE session_rank=1
    ), bin_queue AS (
      SELECT p.*,ROW_NUMBER() OVER(PARTITION BY p.bin ORDER BY p.session_rank,h.session_order) bin_position
      FROM per_session p JOIN session_heads h ON h.bin=p.bin AND h.session_id=p.session_id
    )
    SELECT q.episode_id,(SELECT node_id FROM event_claims ec WHERE ec.episode_id=q.episode_id
      ORDER BY ec.salience DESC,ec.basis_time DESC,ec.node_id LIMIT 1) node_id
    FROM bin_queue q WHERE q.bin_position<=8 ORDER BY q.bin_position,q.bin LIMIT 64
  `).all(bins, fromMs, bins, duration, input.time!.to, input.time!.to, input.time!.from, ...scopeArgs(scoped));
  return temporalRows(rows);
}

function temporalRows(rows: Array<{ episode_id: string; node_id: string | null }>) {
  return {
    episodeIds: rows.map((row) => row.episode_id).filter(uniqueValue),
    seeds: rows.map((row) => row.node_id).filter((value): value is string => Boolean(value)).filter(uniqueValue).slice(0, 8),
  };
}

function aliasCandidates(db: Database, input: RecallMemoryInput, phrases: string[], sourceScope?: { projectId: string | null }): SeedCandidate[] {
  const matchPriority = new Map<string, number>();
  const validity = claimEligibility(input);
  for (const phrase of phrases) {
    const rows = db.query<{ id: string; priority: number }, any>(`
      SELECT e.id,MIN(CASE WHEN a.surface_original=? THEN 0 WHEN a.nfc_key=? THEN 1 ELSE 2 END) priority
      FROM memory_aliases a JOIN memory_nodes e ON e.id=a.node_id
      JOIN memory_chunk_sources s ON s.source_id=a.source_id JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
      WHERE (a.surface_original=? OR a.nfc_key=? OR a.folded_key=?) AND ${validity.sql} AND ${scopeSql(input, sourceScope)} GROUP BY e.id
    `).all(phrase, unicodeNfc(phrase), phrase, unicodeNfc(phrase), unicodeCaseFold(phrase), ...validity.args, ...scopeArgs(input, sourceScope));
    for (const row of rows) matchPriority.set(row.id, Math.min(matchPriority.get(row.id) ?? 3, row.priority));
  }
  return [...matchPriority].sort((a, b) => a[1] - b[1] || compareUtf8(a[0], b[0])).slice(0, MAX_CHANNEL_CANDIDATES)
    .map(([nodeId, priority], index) => ({ nodeId, channel: "alias", rank: index + 1, score: 3 - priority }));
}

function lexicalCandidates(db: Database, input: RecallMemoryInput, cue: string, deadlineAt: number, sourceScope?: { projectId: string | null }): { candidates: SeedCandidate[]; partial: boolean } {
  const queryGrams = foldedGraphemeNgrams(unicodeCaseFold(cue));
  if (queryGrams.length === 0) return { candidates: [], partial: false };
  const validity = claimEligibility(input);
  const n = Number(db.query<{ count: number }, any>(`
    SELECT COUNT(*) count FROM (
      SELECT DISTINCT a.node_id,a.source_id,a.surface_original FROM memory_aliases a
      JOIN memory_nodes e ON e.id=a.node_id
      JOIN memory_chunk_sources s ON s.source_id=a.source_id JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
      WHERE ${validity.sql} AND ${scopeSql(input, sourceScope)}
    )
  `).get(...validity.args, ...scopeArgs(input, sourceScope))?.count ?? 0);
  const matchedDocuments = db.query<{ node_id: string; source_id: string; surface_original: string }, any>(`
    SELECT DISTINCT p.node_id,p.source_id,p.surface_original FROM memory_alias_postings p
    JOIN memory_nodes e ON e.id=p.node_id
    JOIN memory_chunk_sources s ON s.source_id=p.source_id JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE p.gram IN (${queryGrams.map(() => "?").join(",")}) AND ${validity.sql} AND ${scopeSql(input, sourceScope)}
    ORDER BY p.node_id,p.source_id,p.surface_original
  `).all(...queryGrams, ...validity.args, ...scopeArgs(input, sourceScope));
  const documentGrams = new Map<string, { nodeId: string; grams: string[] }>();
  let partial = false;
  for (const document of matchedDocuments) {
    if (Date.now() >= deadlineAt) { partial = true; break; }
    // The surface is already selected by the posting index. Recreate its norm
    // with the writer's exact Unicode algorithm instead of rereading every posting.
    documentGrams.set(JSON.stringify([document.node_id, document.source_id, document.surface_original]), {
      nodeId: document.node_id, grams: foldedGraphemeNgrams(unicodeCaseFold(document.surface_original)),
    });
  }
  const allGrams = [...new Set([...queryGrams, ...[...documentGrams.values()].flatMap((document) => document.grams)])];
  const df = new Map<string, number>();
  if (Date.now() < deadlineAt) {
    // Materialize the eligible corpus once. Repeating it for every 400 grams
    // made query cost grow with both corpus size and matching surface length.
    const rows = db.query<{ gram: string; count: number }, any>(`
      WITH eligible AS MATERIALIZED (
        SELECT DISTINCT a.node_id,a.source_id FROM memory_aliases a
        JOIN memory_nodes e ON e.id=a.node_id
        JOIN memory_chunk_sources s ON s.source_id=a.source_id
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
        WHERE ${validity.sql} AND ${scopeSql(input, sourceScope)}
      )
      SELECT p.gram,COUNT(*) count FROM memory_alias_postings p
      CROSS JOIN eligible d ON d.node_id=p.node_id AND d.source_id=p.source_id
      WHERE p.gram IN (SELECT value FROM json_each(?)) GROUP BY p.gram
    `).all(...validity.args, ...scopeArgs(input, sourceScope), JSON.stringify(allGrams));
    for (const gram of allGrams) df.set(gram, 0);
    for (const row of rows) df.set(row.gram, Number(row.count));
  }
  // An unfinished DF is unknown, not zero frequency. Do not invent scores.
  if (queryGrams.some((gram) => !df.has(gram))) return { candidates: [], partial: true };
  const queryNorm = queryGrams.reduce((sum, gram) => sum + idf(n, df.get(gram) ?? 0), 0);
  const querySet = new Set(queryGrams);
  const scores = new Map<string, number>();
  for (const document of documentGrams.values()) {
    if (document.grams.some((gram) => !df.has(gram))) continue;
    const documentNorm = document.grams.reduce((sum, gram) => sum + idf(n, df.get(gram) ?? 0), 0);
    const matched = document.grams.reduce((sum, gram) => sum + (querySet.has(gram) ? idf(n, df.get(gram) ?? 0) : 0), 0);
    const score = matched / Math.sqrt(queryNorm * documentNorm);
    if (Number.isFinite(score)) scores.set(document.nodeId, Math.max(scores.get(document.nodeId) ?? 0, score));
  }
  const candidates = [...scores].map(([nodeId, score]) => ({ nodeId, channel: "lexical" as const, rank: 0, score }))
    .sort((a, b) => b.score - a.score || compareUtf8(a.nodeId, b.nodeId)).slice(0, MAX_CHANNEL_CANDIDATES)
    .map((item, index) => ({ ...item, rank: index + 1 }));
  return { candidates, partial };
}

function contextCandidates(db: Database, input: RecallMemoryInput, sourceScope?: { projectId: string | null }): { candidates: SeedCandidate[]; sourceIds: Set<string> } {
  if (!input.runtime.sessionId) return { candidates: [], sourceIds: new Set() };
  const canonicalPath = conversationStorePath(input.context.butlerData);
  if (!existsSync(canonicalPath)) {
    return { candidates: [], sourceIds: new Set() };
  }
  const canonical = new Database(canonicalPath, { readonly: true });
  let messageIds: string[];
  try {
    messageIds = canonical.query<{ id: string }, [string]>(`
      SELECT id FROM conversation_messages
      WHERE session_id=? AND status='complete' AND compacted_by_summary_id IS NULL
        AND origin_kind IN ('user_input','assistant_public') AND role IN ('user','assistant')
      ORDER BY seq DESC,id DESC LIMIT 8
    `).all(input.runtime.sessionId).map((message) => message.id);
  } finally { canonical.close(); }
  if (!messageIds.length) return { candidates: [], sourceIds: new Set() };
  const validity = claimEligibility(input);
  const rows = db.query<{ nodeId: string; sourceId: string }, any>(`
    SELECT DISTINCT m.node_id nodeId,m.source_id sourceId FROM memory_evidence m JOIN memory_chunk_sources s ON s.source_id=m.source_id
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    JOIN memory_nodes e ON e.id=m.node_id
    WHERE s.conversation_message_id IN (${messageIds.map(() => "?").join(",")}) AND ${validity.sql} AND ${scopeSql(input, sourceScope)}
    ORDER BY s.observed_at DESC,m.node_id,m.source_id
  `).all(...messageIds, ...validity.args, ...scopeArgs(input, sourceScope));
  const nodeIds = rows.map((row) => row.nodeId).filter(uniqueValue).slice(0, 4);
  return {
    candidates: nodeIds.map((nodeId, index) => ({ nodeId, channel: "context", rank: index + 1, score: 1 })),
    sourceIds: new Set(rows.map((row) => row.sourceId)),
  };
}

function eligibleVectorNodeIds(
  db: Database,
  input: RecallMemoryInput,
  nodeIds: string[],
  sourceScope?: { projectId: string | null },
): Set<string> {
  const unique = [...new Set(nodeIds)].slice(0, MAX_CHANNEL_CANDIDATES);
  if (!unique.length) return new Set();
  const validity = claimEligibility(input);
  return new Set(db.query<{ node_id: string }, any>(`
    SELECT DISTINCT m.node_id FROM memory_evidence m JOIN memory_nodes e ON e.id=m.node_id
    JOIN memory_chunk_sources s ON s.source_id=m.source_id
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE m.node_id IN (${unique.map(() => "?").join(",")}) AND ${validity.sql} AND ${scopeSql(input, sourceScope)}
  `).all(...unique, ...validity.args, ...scopeArgs(input, sourceScope)).map((row) => row.node_id));
}

export function claimEligibility(
  input: RecallMemoryInput,
  entityAlias = "e",
  idColumn = "id",
): { sql: string; args: string[] } {
  const claimTypes = "'preference','goal','constraint','decision','memory_atom'";
  if (input.time?.basis === "event") {
    return {
      sql: `(${entityAlias}.type NOT IN (${claimTypes}) OR (
        (SELECT valid_from FROM memory_claims WHERE node_id=${entityAlias}.${idColumn}) IS NOT NULL AND
        julianday((SELECT valid_from FROM memory_claims WHERE node_id=${entityAlias}.${idColumn}))<julianday(?) AND
        julianday(COALESCE((SELECT valid_to FROM memory_claims WHERE node_id=${entityAlias}.${idColumn}),?))>julianday(?)))`,
      args: [input.time.to, input.time.to, input.time.from],
    };
  }
  return {
    sql: `(${entityAlias}.type NOT IN (${claimTypes}) OR (
      ((SELECT valid_from FROM memory_claims WHERE node_id=${entityAlias}.${idColumn}) IS NULL OR julianday((SELECT valid_from FROM memory_claims WHERE node_id=${entityAlias}.${idColumn}))<=julianday(?)) AND
      ((SELECT valid_to FROM memory_claims WHERE node_id=${entityAlias}.${idColumn}) IS NULL OR julianday((SELECT valid_to FROM memory_claims WHERE node_id=${entityAlias}.${idColumn}))>julianday(?))))`,
    args: [input.asOf, input.asOf],
  };
}

export type EpisodeRelationshipRow = {
  relation: string;
  source_node_id: string;
  target_node_id: string;
  candidate_node_id: string;
  candidate_source_id: string;
  evidence_source_id: string;
};

export function selectEpisodeRelationshipRows(
  db: Database,
  input: RecallMemoryInput,
  episodeId: string,
): EpisodeRelationshipRow[] {
  const relationshipAt = input.time?.basis === "event" ? input.time.from : input.asOf;
  return db.query<EpisodeRelationshipRow, any>(`
    SELECT DISTINCT e.rel_type relation,e.source_node_id,e.target_node_id,
      candidate.node_id candidate_node_id,candidate.source_id candidate_source_id,
      ee.chunk_source_id evidence_source_id
    FROM memory_evidence candidate
    JOIN memory_chunk_sources candidate_source ON candidate_source.source_id=candidate.source_id
    JOIN memory_chunks candidate_chunk ON candidate_chunk.memory_chunk_id=candidate_source.episode_id AND candidate_chunk.current_revision=candidate_source.revision
    JOIN edges e ON e.source_node_id=candidate.node_id OR e.target_node_id=candidate.node_id
    JOIN edge_evidence ee ON ee.edge_id=e.edge_id
    JOIN memory_chunk_sources s ON s.source_id=ee.chunk_source_id
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE candidate.episode_id=? AND e.rel_type IN ('supersedes','contradicts') AND e.status='active'
      AND (e.valid_from IS NULL OR julianday(e.valid_from)<=julianday(?))
      AND (e.valid_to IS NULL OR julianday(e.valid_to)>julianday(?))
      AND ${scopeSql(input, undefined, "candidate_source", "candidate_chunk")} AND ${scopeSql(input)}
    ORDER BY e.rel_type,e.edge_id,ee.chunk_source_id
  `).all(
    episodeId,
    relationshipAt,
    relationshipAt,
    ...scopeArgs(input),
    ...scopeArgs(input),
  );
}

export function scopeSql(
  input: RecallMemoryInput,
  sourceScope?: { projectId: string | null },
  sourceAlias = "s",
  chunkAlias = "c",
): string {
  const conversationAuthority = input.includeInternal
    ? `${sourceAlias}.source_kind='conversation' AND ${sourceAlias}.origin_kind IN ('user_input','assistant_public','unknown','internal_control')`
    : `${sourceAlias}.source_kind='conversation' AND ${sourceAlias}.origin_kind IN ('user_input','assistant_public')`;
  const typedAuthority = `(${sourceAlias}.source_kind='task_report' AND ${sourceAlias}.role='task' AND ${sourceAlias}.basis='reviewed_task')
    OR (${sourceAlias}.source_kind='explicit_record' AND ${sourceAlias}.role='explicit' AND ${sourceAlias}.basis='user_statement')`;
  const clauses = [`${chunkAlias}.status='active'`, `((${conversationAuthority}) OR (${typedAuthority}))`];
  if (input.scope === "current_session") clauses.push(`${chunkAlias}.conversation_session_id=?`);
  if (input.scope === "current_project") clauses.push(`${chunkAlias}.project_id=?`);
  if (input.sessionIds.length) clauses.push(`${chunkAlias}.conversation_session_id IN (${input.sessionIds.map(() => "?").join(",")})`);
  if (input.projectFilter === "unassigned") clauses.push(`${chunkAlias}.project_id IS NULL`);
  if (input.projectFilter === "selected") clauses.push(`${chunkAlias}.project_id IN (${input.projectIds.map(() => "?").join(",")})`);
  if (sourceScope) clauses.push(sourceScope.projectId === null ? `${chunkAlias}.project_id IS NULL` : `(${chunkAlias}.project_id IS NULL OR ${chunkAlias}.project_id=?)`);
  clauses.push(`julianday(${sourceAlias}.observed_at)<=julianday(?)`);
  if (input.time?.basis === "conversation") clauses.push(`julianday(${sourceAlias}.observed_at)>=julianday(?) AND julianday(${sourceAlias}.observed_at)<julianday(?)`);
  return clauses.join(" AND ");
}

export function scopeArgs(input: RecallMemoryInput, sourceScope?: { projectId: string | null }): Array<string | null> {
  const args: Array<string | null> = [];
  if (input.scope === "current_session") args.push(input.runtime.sessionId);
  if (input.scope === "current_project") args.push(input.runtime.projectId);
  args.push(...input.sessionIds);
  if (input.projectFilter === "selected") args.push(...input.projectIds);
  if (sourceScope?.projectId) args.push(sourceScope.projectId);
  args.push(input.asOf);
  if (input.time?.basis === "conversation") args.push(input.time.from, input.time.to);
  return args;
}

function seedFusionScore(channels: Map<SeedCandidate["channel"], SeedCandidate>): number {
  return (channels.has("alias") ? 3 / (60 + channels.get("alias")!.rank) : 0) +
    (channels.has("lexical") ? 1 / (60 + channels.get("lexical")!.rank) : 0) +
    (channels.has("vector") ? 2 / (60 + channels.get("vector")!.rank) : 0);
}

function idf(n: number, df: number): number { return Math.log(1 + (n + 1) / (df + 1)); }
function uniqueOriginalByNfc(values: string[]): string[] {
  const seen = new Set<string>();
  return values.map((value) => value.trim()).filter((value) => {
    const key = unicodeNfc(value);
    return Boolean(value) && !seen.has(key) && Boolean(seen.add(key));
  });
}
function uniqueValue<T>(value: T, index: number, values: T[]): boolean { return values.indexOf(value) === index; }
export function compareUtf8(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }

/** Candidate limits apply after source scope filtering, over the entire source index. */
export function selectRawSourceCandidates(
  db: Database,
  input: RecallMemoryInput,
  deadlineAt: number,
): { sources: Array<{ sourceId: string; episodeId: string; revision: string; score: number; exactMatch: number }>; partial: boolean } {
  const maxQueryTerms = 256;
  const allTerms = sourceQueryTerms([input.cue, ...(input.seedPhrases ?? [])]);
  const terms = allTerms.slice(0, maxQueryTerms);
  if (!terms.length || Date.now() >= deadlineAt) return { sources: [], partial: Date.now() >= deadlineAt };
  // Frequency statistics use the same current, authorized source population as
  // the candidates. Common sentence endings must not count like rare subjects.
  const stats = db.query<{ count: number; averageLength: number }, any>(`
    SELECT COUNT(*) count,AVG(length(raw.text)) averageLength
    FROM memory_source_text raw JOIN memory_source_leaves s ON s.source_id=raw.source_id
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE ${scopeSql(input)}
  `).get(...scopeArgs(input));
  const frequencies = db.query<{ term: string; count: number }, any>(`
    SELECT p.term,COUNT(*) count FROM memory_source_terms p
    JOIN memory_source_text raw ON raw.id=p.source_key
    JOIN memory_source_leaves s ON s.source_id=raw.source_id
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE p.term IN (SELECT value FROM json_each(?)) AND ${scopeSql(input)} GROUP BY p.term
  `).all(JSON.stringify(terms), ...scopeArgs(input));
  const df = new Map(frequencies.map((row) => [row.term, row.count]));
  const weights = terms.map((term) => ({ term, weight: Math.log(1 +
    ((stats?.count ?? 0) - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5)) }));
  const queryWeight = weights.reduce((sum, row) => sum + row.weight, 0);
  const minimumMatches = terms.length === 1 ? 1 : 2;
  const sources = db.query<{ sourceId: string; episodeId: string; revision: string; score: number; exactMatch: number }, any>(`
    WITH query AS (SELECT json_extract(value,'$.term') term,json_extract(value,'$.weight') weight FROM json_each(?))
    SELECT s.source_id sourceId,s.episode_id episodeId,s.revision,
      SUM(q.weight)/? * 2.2/(1 + 1.2 * (0.25 + 0.75 * length(raw.text)/?)) score,
      CASE WHEN instr(raw.text,?)>0 THEN 1 ELSE 0 END exactMatch
    FROM query q JOIN memory_source_terms p ON p.term=q.term
    JOIN memory_source_text raw ON raw.id=p.source_key
    JOIN memory_source_leaves s ON s.source_id=raw.source_id
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE ${scopeSql(input)}
    GROUP BY s.source_id
    HAVING COUNT(DISTINCT p.term)>=?
    ORDER BY exactMatch DESC,score DESC,s.observed_at DESC,s.source_id
    LIMIT ?
  ` ).all(JSON.stringify(weights), queryWeight, Math.max(1, stats?.averageLength ?? 1),
    input.cue.trim(), ...scopeArgs(input), minimumMatches, MAX_CHANNEL_CANDIDATES);
  return { sources, partial: allTerms.length > maxQueryTerms || Date.now() >= deadlineAt };
}
