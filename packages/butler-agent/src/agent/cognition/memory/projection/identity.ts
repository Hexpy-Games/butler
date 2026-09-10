import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { acquireConsolidationLockAsync, consolidationLockPath, releaseConsolidationLock } from "../scripts/lib/lock.ts";
import { resolveMemoryGeneration } from "./generation.ts";
import type { ExtractInput, MemoryExecutionContext } from "./contracts.ts";
import { assertCanonicalProjectionSourcesCurrent, hydrateSource } from "./source.ts";
import { openProjectionDb, sourceRows, type ProjectionSourceRow } from "./store.ts";

export type IdentityQuote = { source_ref: string; quote: string; occurrence: number };
export type IdentityHistoryRef = { job_ref: string; decision_ref: string };
export type ExpectedIdentityState = { direct_redirect: string | null; resolved_node_ref: string; history_head: IdentityHistoryRef | null };
export type IdentityCommand =
  | { schema: "butler.memory-identity-command.v1"; expected_generation: string; operation: "inspect"; source_ref: string; node_refs: [string, string] }
  | { schema: "butler.memory-identity-command.v1"; expected_generation: string; operation: "apply"; operation_id: string; decision: "same_entity"; reason: "explicit_alias" | "explicit_identity_correction"; source: IdentityQuote; loser_node_ref: string; canonical_node_ref: string; loser_evidence: IdentityQuote; canonical_evidence: IdentityQuote; expected_loser: ExpectedIdentityState; expected_canonical: ExpectedIdentityState }
  | { schema: "butler.memory-identity-command.v1"; expected_generation: string; operation: "revoke"; operation_id: string; source: IdentityQuote; decision_job_ref: string; decision_ref: string; expected_loser: ExpectedIdentityState };

type IdentityRecord = {
  schema: "butler.memory-identity-decision.v1";
  decision_ref: string;
  operation_id: string;
  payload_digest: string;
  operation: "apply" | "revoke" | "invalidate";
  reason: "explicit_alias" | "explicit_identity_correction" | "operator_revoke" | "source_revision";
  decision_origin: "operator_cli" | "source_revision";
  literal_loser: string;
  literal_canonical: string | null;
  resolved_target: string | null;
  previous_head: IdentityHistoryRef | null;
  previous_direct_redirect: string | null;
  previous_owner: string;
  resulting_direct_redirect: string | null;
  resulting_owner: string;
  source_refs: string[];
  node_type: string;
  identity_scope: string;
  project_id: string | null;
  decision_source: NormalizedIdentityEvidence;
  loser_source: NormalizedIdentityEvidence | null;
  canonical_source: NormalizedIdentityEvidence | null;
  target_decision: IdentityHistoryRef | null;
  source_revision: string;
  source_observed_at: string;
  recorded_at: string;
  recorded_outcome: "applied" | "restored_previous" | "restored_independent" | "invalidated";
};

type NormalizedIdentityEvidence = {
  source_ref: string;
  episode_id: string;
  revision: string;
  content_hash: string;
  byte_start: number;
  byte_end: number;
  quote: string;
  quote_byte_start: number;
  quote_byte_end: number;
  project_id: string | null;
  session_id: string;
  origin_kind: string;
  role: string;
  observed_at: string;
};

export type IdentityReadScope = {
  butlerData: string;
  asOf: string;
  scope: "current_session" | "current_project" | "all_user_sessions";
  currentSessionId: string;
  currentProjectId: string | null;
  sessionIds: string[];
  projectFilter: "any" | "unassigned" | "selected";
  projectIds: string[];
  includeInternal: boolean;
  deadlineAt: number;
};

export type IdentityReceipt = {
  ok: true;
  operation: IdentityCommand["operation"];
  source_job_ref: string;
  decision_ref: string | null;
  recorded_outcome: string;
  current_disposition: "active" | "revoked" | "source_superseded" | "replaced_by_later_decision";
  replayed: boolean;
  graph_revision: number;
  pending_projection_counts: { node_vectors: number; hot_cache: number };
  states?: Record<string, ExpectedIdentityState>;
};

export async function executeMemoryIdentityCommand(input: {
  context: MemoryExecutionContext;
  command: IdentityCommand;
}): Promise<IdentityReceipt> {
  validateCommand(input.command);
  if (input.context.target.kind !== "active" || input.context.target.expected_generation !== input.command.expected_generation)
    throw new Error("memory_generation_changed");
  const generation = resolveMemoryGeneration(input.context);
  const db = openProjectionDb(generation.graphPath);
  try {
    const sourceRef = input.command.operation === "inspect" ? input.command.source_ref : input.command.source.source_ref;
    const source = requireSourceAndJob(db, sourceRef);
    if (input.command.operation === "inspect") {
      assertCurrentUserSource(input.context.butlerData, db, source.row);
      const decisionProject = sourceProject(db, source.row);
      for (const nodeRef of input.command.node_refs) assertNodeReadableFromProject(requireNode(db, nodeRef), decisionProject);
      return receipt(db, input.command.operation, source.jobId, null, "inspected", "active", false, {
        states: Object.fromEntries(input.command.node_refs.map((node) => [node, identityState(db, node)])),
      });
    }
    const mutation = input.command;
    const digest = sha(canonicalJson(mutation));
    const replay = findOperation(db, source.jobId, mutation.operation_id);
    if (replay) {
      if (replay.payload_digest !== digest) throw new Error("memory_identity_operation_conflict");
      return receipt(db, mutation.operation, source.jobId, replay.decision_ref, replay.recorded_outcome,
        currentDisposition(db, source.row, replay), true);
    }
    assertCurrentUserSource(input.context.butlerData, db, source.row);
    normalizeEvidence(db, input.context.butlerData, source.row, input.command.source);
    const lockPath = consolidationLockPath(input.context.butlerData);
    const lease = await acquireConsolidationLockAsync(lockPath, {
      purpose: "projection",
      waitClass: "interactive",
      signal: input.context.signal,
    });
    if (!lease) throw new Error("memory_write_busy");
    let commit = false;
    try {
      resolveMemoryGeneration(input.context);
      const result = db.transaction(() => mutation.operation === "apply"
        ? applyIdentity(db, input.context.butlerData, source, mutation, digest)
        : revokeIdentity(db, input.context.butlerData, source, mutation, digest))();
      commit = true;
      return result;
    } finally { releaseConsolidationLock(lockPath, lease, commit); }
  } finally { db.close(); }
}

function applyIdentity(
  db: Database,
  butlerData: string,
  source: { row: ProjectionSourceRow; jobId: string },
  command: Extract<IdentityCommand, { operation: "apply" }>,
  digest: string,
): IdentityReceipt {
  assertCurrentUserSource(butlerData, db, source.row);
  const loser = requireNode(db, command.loser_node_ref);
  const canonical = requireNode(db, command.canonical_node_ref);
  if (loser.id === canonical.id || loser.type !== canonical.type || !["entity", "project"].includes(loser.type)) throw new Error("memory_identity_type_mismatch");
  if (loser.identity_scope !== canonical.identity_scope || loser.project_id !== canonical.project_id) throw new Error("memory_identity_scope_mismatch");
  const decisionSource = normalizeEvidence(db, butlerData, source.row, command.source);
  assertSourceScope(db, source.row, loser.identity_scope, loser.project_id);
  const loserSource = validateNodeEvidence(db, butlerData, command.loser_evidence, loser.id);
  const canonicalSource = validateNodeEvidence(db, butlerData, command.canonical_evidence, canonical.id);
  assertEvidenceReadableFromDecision(decisionSource, loserSource);
  assertEvidenceReadableFromDecision(decisionSource, canonicalSource);
  assertExpected(identityState(db, loser.id), command.expected_loser);
  assertExpected(identityState(db, canonical.id), command.expected_canonical);
  const target = resolveCurrentNode(db, canonical.id);
  if (target === loser.id || redirectChain(db, target).includes(loser.id)) throw new Error("memory_identity_cycle");
  const previous = identityState(db, loser.id);
  const decisionRef = sha([source.jobId, command.operation_id].join("\0"));
  const record: IdentityRecord = {
    schema: "butler.memory-identity-decision.v1", decision_ref: decisionRef, operation_id: command.operation_id,
    payload_digest: digest, operation: "apply", decision_origin: "operator_cli", literal_loser: loser.id,
    reason: command.reason,
    literal_canonical: canonical.id, resolved_target: target, previous_head: previous.history_head,
    previous_direct_redirect: previous.direct_redirect, previous_owner: previous.resolved_node_ref,
    resulting_direct_redirect: canonical.id, resulting_owner: target,
    source_refs: [command.source.source_ref, command.loser_evidence.source_ref, command.canonical_evidence.source_ref],
    node_type: loser.type, identity_scope: loser.identity_scope, project_id: loser.project_id,
    decision_source: decisionSource, loser_source: loserSource, canonical_source: canonicalSource, target_decision: null,
    source_revision: source.row.revision, source_observed_at: source.row.observed_at, recorded_at: new Date().toISOString(), recorded_outcome: "applied",
  };
  appendRecord(db, source.jobId, record);
  db.query("UPDATE entities SET canonical_node_id=?,identity_history_job_id=?,identity_history_ref=? WHERE id=?")
    .run(canonical.id, source.jobId, decisionRef, loser.id);
  addLocators(db, source.row.episode_id, source.jobId, [loser.id, canonical.id, target], record.source_refs);
  markIdentityDerivativesPending(db, loser.id, canonical.id);
  incrementGraphRevision(db);
  return receipt(db, "apply", source.jobId, decisionRef, "applied", "active", false);
}

function revokeIdentity(
  db: Database,
  butlerData: string,
  source: { row: ProjectionSourceRow; jobId: string },
  command: Extract<IdentityCommand, { operation: "revoke" }>,
  digest: string,
): IdentityReceipt {
  assertCurrentUserSource(butlerData, db, source.row);
  const target = findRecord(db, command.decision_job_ref, command.decision_ref);
  if (!target || target.operation !== "apply") throw new Error("memory_identity_decision_not_found");
  const loser = requireNode(db, target.literal_loser);
  const decisionSource = normalizeEvidence(db, butlerData, source.row, command.source);
  assertNodeReadableFromProject(loser, decisionSource.project_id);
  assertExpected(identityState(db, loser.id), command.expected_loser);
  if (loser.identity_history_job_id !== command.decision_job_ref || loser.identity_history_ref !== command.decision_ref)
    throw new Error("memory_identity_state_changed");
  const restored = validPreimage(db, target, butlerData) ? target.previous_direct_redirect : null;
  const owner = restored ? resolveCurrentNode(db, restored) : loser.id;
  const decisionRef = sha([source.jobId, command.operation_id].join("\0"));
  const record: IdentityRecord = {
    schema: "butler.memory-identity-decision.v1", decision_ref: decisionRef, operation_id: command.operation_id,
    payload_digest: digest, operation: "revoke", decision_origin: "operator_cli", literal_loser: loser.id,
    reason: "operator_revoke",
    literal_canonical: target.literal_canonical, resolved_target: target.resolved_target,
    previous_head: { job_ref: command.decision_job_ref, decision_ref: command.decision_ref },
    previous_direct_redirect: loser.canonical_node_id, previous_owner: resolveCurrentNode(db, loser.id),
    resulting_direct_redirect: restored, resulting_owner: owner, source_refs: [command.source.source_ref],
    node_type: loser.type, identity_scope: loser.identity_scope, project_id: loser.project_id,
    decision_source: decisionSource, loser_source: null, canonical_source: null,
    target_decision: { job_ref: command.decision_job_ref, decision_ref: command.decision_ref },
    source_revision: source.row.revision, source_observed_at: source.row.observed_at, recorded_at: new Date().toISOString(),
    recorded_outcome: restored ? "restored_previous" : "restored_independent",
  };
  appendRecord(db, source.jobId, record);
  db.query("UPDATE entities SET canonical_node_id=?,identity_history_job_id=?,identity_history_ref=? WHERE id=?")
    .run(restored, source.jobId, decisionRef, loser.id);
  addLocators(db, source.row.episode_id, source.jobId, [loser.id], record.source_refs);
  markIdentityDerivativesPending(db, loser.id, target.literal_canonical ?? loser.id);
  incrementGraphRevision(db);
  return receipt(db, "revoke", source.jobId, decisionRef, record.recorded_outcome, "revoked", false);
}

export function invalidateIdentityBindingsForSupersededSources(
  db: Database,
  input: { butlerData: string; oldSourceIds: string[]; newJobId: string; newEpisodeId: string; newRevision: string; recordedAt?: string },
): number {
  if (!input.oldSourceIds.length) return 0;
  const relations = input.oldSourceIds.map(() => "?").join(",");
  const refs = db.query<{ relation: string; memory_chunk_id: string }, string[]>(`SELECT DISTINCT relation,memory_chunk_id FROM memory_chunk_graph_refs
    WHERE graph_ref_type='identity_source_job' AND graph_ref_id IN (${relations}) ORDER BY relation`).all(...input.oldSourceIds);
  let changed = 0;
  for (const locator of refs) {
    const oldJob = parseIdentityJobRelation(locator.relation);
    if (!oldJob) continue;
    const owner = db.query<{ episode_id: string }, [string]>("SELECT episode_id FROM memory_projection_jobs WHERE job_id=?").get(oldJob);
    if (!owner || owner.episode_id !== locator.memory_chunk_id) continue;
    for (const record of recordsForJob(db, oldJob)) {
      if (!record.source_refs.some((ref) => input.oldSourceIds.includes(ref))) continue;
      const node = requireNode(db, record.literal_loser);
      if (node.identity_history_job_id !== oldJob || node.identity_history_ref !== record.decision_ref) continue;
      const restored = record.operation === "apply" && validPreimage(db, record, input.butlerData) ? record.previous_direct_redirect : null;
      const replacementSource = db.query<ProjectionSourceRow, [string, string]>(
        "SELECT * FROM memory_chunk_sources WHERE episode_id=? AND revision=? ORDER BY source_id LIMIT 1",
      ).get(input.newEpisodeId, input.newRevision);
      if (!replacementSource) continue;
      const ref = sha([input.newJobId, "invalidate", record.decision_ref, input.newRevision].join("\0"));
      const invalidation: IdentityRecord = {
        ...record, decision_ref: ref, operation_id: `invalidate:${record.decision_ref}`, payload_digest: sha(input.newRevision),
        operation: "invalidate", decision_origin: "source_revision", reason: "source_revision", previous_head: { job_ref: oldJob, decision_ref: record.decision_ref },
        previous_direct_redirect: node.canonical_node_id, previous_owner: resolveCurrentNode(db, node.id),
        resulting_direct_redirect: restored, resulting_owner: restored ? resolveCurrentNode(db, restored) : node.id,
        source_refs: [...new Set([replacementSource.source_id, ...input.oldSourceIds])].sort(), source_revision: input.newRevision,
        decision_source: normalizedSourceRow(db, replacementSource), loser_source: null, canonical_source: null,
        target_decision: { job_ref: oldJob, decision_ref: record.decision_ref },
        source_observed_at: replacementSource.observed_at, recorded_at: input.recordedAt ?? new Date().toISOString(), recorded_outcome: "invalidated",
      };
      appendRecord(db, input.newJobId, invalidation);
      db.query("UPDATE entities SET canonical_node_id=?,identity_history_job_id=?,identity_history_ref=? WHERE id=?")
        .run(restored, input.newJobId, ref, node.id);
      addLocators(db, input.newEpisodeId, input.newJobId, [node.id], invalidation.source_refs);
      markIdentityDerivativesPending(db, node.id, record.literal_canonical ?? node.id);
      incrementGraphRevision(db);
      changed += 1;
    }
  }
  return changed;
}

export function resolveIdentityAt(db: Database, nodeId: string, input: IdentityReadScope): { nodeId: string; partial: boolean } {
  return resolveIdentityAtInternal(db, nodeId, input, new Set<string>());
}

export function resolveIdentityForProjectionInput(
  db: Database,
  butlerData: string,
  input: ExtractInput,
  nodeId: string,
): { nodeId: string; partial: boolean } {
  const sources = sourceRows(db, input.source_units.map((unit) => unit.ref));
  if (!sources.length || sources.length !== input.source_units.length) return { nodeId, partial: true };
  try { assertCanonicalProjectionSourcesCurrent(butlerData, db, sources); }
  catch { return { nodeId, partial: true }; }
  const sessionId = sources[0]!.conversation_session_id;
  if (sources.some((source) => source.conversation_session_id !== sessionId)) return { nodeId, partial: true };
  const asOf = input.source_units.reduce((latest, unit) => unit.observed_at > latest ? unit.observed_at : latest, input.source_units[0]!.observed_at);
  return resolveIdentityAt(db, nodeId, {
    butlerData,
    asOf,
    scope: input.bound_project_id ? "current_project" : "all_user_sessions",
    currentSessionId: sessionId,
    currentProjectId: input.bound_project_id,
    sessionIds: [],
    projectFilter: input.bound_project_id ? "selected" : "unassigned",
    projectIds: input.bound_project_id ? [input.bound_project_id] : [],
    includeInternal: false,
    deadlineAt: Date.now() + 5_000,
  });
}

function resolveIdentityAtInternal(db: Database, nodeId: string, input: IdentityReadScope, visited: Set<string>): { nodeId: string; partial: boolean } {
  const node = requireNode(db, nodeId);
  let head = node.identity_history_job_id && node.identity_history_ref
    ? { job_ref: node.identity_history_job_id, decision_ref: node.identity_history_ref }
    : null;
  while (head) {
    if (Date.now() >= input.deadlineAt || visited.size >= 64) return { nodeId, partial: true };
    const key = `${head.job_ref}\0${head.decision_ref}`;
    if (visited.has(key)) return { nodeId, partial: true };
    visited.add(key);
    const record = findRecord(db, head.job_ref, head.decision_ref);
    if (!record) return { nodeId, partial: true };
    if (record.recorded_at <= input.asOf && record.source_observed_at <= input.asOf) {
      const scope = recordScopeStatus(db, record, input);
      if (scope.inScope && !scope.authoritative) return { nodeId, partial: true };
      if (scope.authoritative) {
        if (record.operation === "apply" && record.literal_canonical)
          return resolveIdentityAtInternal(db, record.literal_canonical, input, visited);
        if (record.operation === "revoke" || record.operation === "invalidate")
          return resolveAuthorizedPreimage(db, nodeId, record, input, visited);
      }
    }
    if (!record.previous_head) return { nodeId, partial: false };
    head = record.previous_head;
  }
  return { nodeId, partial: false };
}

export function identityMembersForTarget(db: Database, target: string, input: IdentityReadScope & { limit: number }): { members: string[]; partial: boolean } {
  const members: string[] = [];
  let partial = false;
  const visitedJobs = new Set<string>();
  const worklist = [target];
  const visitedTargets = new Set<string>();
  while (worklist.length && members.length < input.limit && Date.now() < input.deadlineAt) {
    const indexedTarget = worklist.shift()!;
    if (visitedTargets.has(indexedTarget)) continue;
    visitedTargets.add(indexedTarget);
    let afterEpisode = "", afterRelation = "";
    while (members.length < input.limit && Date.now() < input.deadlineAt) {
      const jobs = db.query<{ relation: string; memory_chunk_id: string }, [string, string, string, string]>(`SELECT relation,memory_chunk_id FROM memory_chunk_graph_refs
        WHERE graph_ref_type='identity_endpoint_job' AND graph_ref_id=?
          AND (memory_chunk_id>? OR (memory_chunk_id=? AND relation>?))
        ORDER BY memory_chunk_id,relation LIMIT 64`).all(indexedTarget, afterEpisode, afterEpisode, afterRelation);
      if (!jobs.length) break;
      for (const locator of jobs) {
        afterEpisode = locator.memory_chunk_id;
        afterRelation = locator.relation;
        if (Date.now() >= input.deadlineAt || members.length >= input.limit) { partial = true; break; }
        const job = parseIdentityJobRelation(locator.relation);
        const visitKey = job ? `${indexedTarget}\0${job}` : "";
        if (!job || visitedJobs.has(visitKey)) continue;
        visitedJobs.add(visitKey);
        const owner = db.query<{ episode_id: string }, [string]>("SELECT episode_id FROM memory_projection_jobs WHERE job_id=?").get(job);
        if (!owner || owner.episode_id !== locator.memory_chunk_id) { partial = true; continue; }
        for (const record of recordsForJob(db, job)) {
          if (Date.now() >= input.deadlineAt || members.length >= input.limit) { partial = true; break; }
          if (record.operation !== "apply" || (record.literal_canonical !== indexedTarget && record.resolved_target !== indexedTarget)) continue;
          const resolved = resolveIdentityAt(db, record.literal_loser, input);
          partial ||= resolved.partial;
          if (resolved.nodeId === target && !members.includes(record.literal_loser)) {
            members.push(record.literal_loser);
            worklist.push(record.literal_loser);
          }
        }
      }
      if (jobs.length < 64) break;
    }
  }
  if (Date.now() >= input.deadlineAt || (worklist.length > 0 && members.length >= input.limit)) partial = true;
  return { members, partial };
}

function requireSourceAndJob(db: Database, sourceRef: string): { row: ProjectionSourceRow; jobId: string } {
  const row = sourceRows(db, [sourceRef])[0];
  if (!row) throw new Error("memory_identity_source_not_registered");
  const job = db.query<{ job_id: string }, [string, string]>("SELECT job_id FROM memory_projection_jobs WHERE episode_id=? AND revision=?").get(row.episode_id, row.revision);
  if (!job) throw new Error("memory_identity_source_not_registered");
  return { row, jobId: job.job_id };
}

function assertCurrentUserSource(butlerData: string, db: Database, row: ProjectionSourceRow): void {
  const current = db.query<{ current_revision: string }, [string]>("SELECT current_revision FROM memory_chunks WHERE memory_chunk_id=?").get(row.episode_id);
  if (current?.current_revision !== row.revision || row.role !== "user" || row.origin_kind !== "user_input") throw new Error("memory_identity_source_not_current");
  assertCanonicalProjectionSourcesCurrent(butlerData, db, [row]);
}

function validateNodeEvidence(db: Database, butlerData: string, quote: IdentityQuote, nodeId: string): NormalizedIdentityEvidence {
  const source = sourceRows(db, [quote.source_ref])[0];
  if (!source || !db.query("SELECT 1 FROM entity_mentions WHERE entity_id=? AND source_id=?").get(nodeId, quote.source_ref))
    throw new Error("memory_identity_evidence_mismatch");
  assertCurrentUserSource(butlerData, db, source);
  return normalizeEvidence(db, butlerData, source, quote);
}

function normalizeEvidence(db: Database, butlerData: string, row: ProjectionSourceRow, quote: IdentityQuote): NormalizedIdentityEvidence {
  if (!quote.quote || quote.occurrence < 0 || !Number.isSafeInteger(quote.occurrence) || graphemeCount(quote.quote) > 480) throw new Error("memory_identity_quote_invalid");
  const text = hydrateSource(butlerData, row).text;
  const span = findLiteralOrNfcOccurrence(text, quote.quote, quote.occurrence);
  if (!span) throw new Error("memory_identity_quote_invalid");
  const originalQuote = text.slice(span.start, span.end);
  return {
    ...normalizedSourceRow(db, row), quote: originalQuote,
    quote_byte_start: row.byte_start + Buffer.byteLength(text.slice(0, span.start)),
    quote_byte_end: row.byte_start + Buffer.byteLength(text.slice(0, span.end)),
  };
}

function normalizedSourceRow(db: Database, row: ProjectionSourceRow): NormalizedIdentityEvidence {
  const chunk = db.query<{ project_id: string | null }, [string]>("SELECT project_id FROM memory_chunks WHERE memory_chunk_id=?").get(row.episode_id);
  if (!chunk) throw new Error("memory_identity_source_not_registered");
  return {
    source_ref: row.source_id, episode_id: row.episode_id, revision: row.revision,
    content_hash: row.content_hash, byte_start: row.byte_start, byte_end: row.byte_end,
    quote: "", quote_byte_start: row.byte_start, quote_byte_end: row.byte_start,
    project_id: chunk.project_id, session_id: row.conversation_session_id,
    origin_kind: row.origin_kind, role: row.role, observed_at: row.observed_at,
  };
}

function sourceProject(db: Database, row: ProjectionSourceRow): string | null {
  return normalizedSourceRow(db, row).project_id;
}

function assertNodeReadableFromProject(node: ReturnType<typeof requireNode>, decisionProject: string | null): void {
  if (node.identity_scope === "project" && (!decisionProject || node.project_id !== decisionProject))
    throw new Error("memory_identity_scope_mismatch");
}

function assertEvidenceReadableFromDecision(decision: NormalizedIdentityEvidence, evidence: NormalizedIdentityEvidence): void {
  if (evidence.project_id !== null && evidence.project_id !== decision.project_id)
    throw new Error("memory_identity_scope_mismatch");
}

function requireNode(db: Database, id: string): { id: string; type: string; identity_scope: string; project_id: string | null; canonical_node_id: string | null; identity_history_job_id: string | null; identity_history_ref: string | null } {
  const row = db.query<any, [string]>("SELECT id,type,identity_scope,project_id,canonical_node_id,identity_history_job_id,identity_history_ref FROM entities WHERE id=?").get(id);
  if (!row) throw new Error("memory_identity_node_not_found");
  return row;
}

function identityState(db: Database, id: string): ExpectedIdentityState {
  const node = requireNode(db, id);
  return { direct_redirect: node.canonical_node_id, resolved_node_ref: resolveCurrentNode(db, id), history_head: node.identity_history_job_id && node.identity_history_ref ? { job_ref: node.identity_history_job_id, decision_ref: node.identity_history_ref } : null };
}

function resolveCurrentNode(db: Database, id: string): string {
  const chain = redirectChain(db, id);
  return chain.at(-1) ?? id;
}

function redirectChain(db: Database, id: string): string[] {
  const output = [id];
  let current = id;
  for (let count = 0; count < 64; count += 1) {
    const next = requireNode(db, current).canonical_node_id;
    if (!next) return output;
    if (output.includes(next)) throw new Error("memory_identity_cycle");
    output.push(next);
    current = next;
  }
  throw new Error("memory_identity_history_limit");
}

function assertExpected(actual: ExpectedIdentityState, expected: ExpectedIdentityState): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("memory_identity_state_changed");
}

function assertSourceScope(db: Database, source: ProjectionSourceRow, scope: string, projectId: string | null): void {
  const chunk = db.query<{ project_id: string | null }, [string]>("SELECT project_id FROM memory_chunks WHERE memory_chunk_id=?").get(source.episode_id);
  if (!chunk || (scope === "project" && chunk.project_id !== projectId)) throw new Error("memory_identity_scope_mismatch");
}

function appendRecord(db: Database, jobId: string, record: IdentityRecord): void {
  const records = recordsForJob(db, jobId);
  if (records.some((value) => value.decision_ref === record.decision_ref)) return;
  db.query("UPDATE memory_projection_jobs SET identity_decisions_json=? WHERE job_id=?")
    .run(JSON.stringify([...records, record]), jobId);
}

function recordsForJob(db: Database, jobId: string): IdentityRecord[] {
  const value = db.query<{ identity_decisions_json: string }, [string]>("SELECT identity_decisions_json FROM memory_projection_jobs WHERE job_id=?").get(jobId)?.identity_decisions_json;
  if (!value) return [];
  const records = JSON.parse(value) as IdentityRecord[];
  return Array.isArray(records) ? records : [];
}

function findOperation(db: Database, jobId: string, operationId: string): IdentityRecord | null {
  return recordsForJob(db, jobId).find((record) => record.operation_id === operationId) ?? null;
}

function findRecord(db: Database, jobId: string, decisionRef: string): IdentityRecord | null {
  return recordsForJob(db, jobId).find((record) => record.decision_ref === decisionRef) ?? null;
}

function addLocators(db: Database, episodeId: string, jobId: string, endpoints: string[], sources: string[]): void {
  if (!/^[0-9a-f]{64}$/u.test(jobId)) throw new Error("memory_identity_job_invalid");
  const relation = `identity_job:${jobId}`;
  const insert = db.query("INSERT OR IGNORE INTO memory_chunk_graph_refs(memory_chunk_id,graph_ref_type,graph_ref_id,relation) VALUES(?,?,?,?)");
  for (const endpoint of new Set(endpoints)) insert.run(episodeId, "identity_endpoint_job", endpoint, relation);
  for (const source of new Set(sources)) insert.run(episodeId, "identity_source_job", source, relation);
}

function parseIdentityJobRelation(value: string): string | null {
  const match = /^identity_job:([0-9a-f]{64})$/u.exec(value);
  return match?.[1] ?? null;
}

function validPreimage(db: Database, record: IdentityRecord, butlerData: string): boolean {
  if (!record.previous_direct_redirect || !record.previous_head) return false;
  const previous = findOwningApplyForState(db, record.previous_head, record.previous_direct_redirect);
  if (!previous || !recordSourcesCurrent(db, previous, butlerData)) return false;
  try { return !redirectChain(db, record.previous_direct_redirect).includes(record.literal_loser); }
  catch { return false; }
}

function recordSourcesCurrent(db: Database, record: IdentityRecord, butlerData: string): boolean {
  const bindings = [record.decision_source, record.loser_source, record.canonical_source]
    .filter((value): value is NormalizedIdentityEvidence => Boolean(value));
  return bindings.length > 0 && bindings.every((binding) => bindingCurrent(db, binding, butlerData));
}

function markIdentityDerivativesPending(db: Database, ...nodeIds: string[]): void {
  for (const nodeId of new Set(nodeIds)) db.query("UPDATE memory_vector_units SET state='pending',error_code=NULL,next_attempt_at=NULL WHERE record_kind='node' AND owner_id=?").run(nodeId);
  db.query("UPDATE memory_projection_jobs SET hot_cache_state=? WHERE job_id IN (SELECT DISTINCT job_id FROM memory_vector_units WHERE owner_id IN (" + [...new Set(nodeIds)].map(() => "?").join(",") + "))")
    .run(JSON.stringify({ state: "pending", blocked_by: null }), ...new Set(nodeIds));
}

function incrementGraphRevision(db: Database): void {
  db.query("UPDATE memory_state SET value=CAST(value AS INTEGER)+1 WHERE key='graph_revision'").run();
}

function currentDisposition(db: Database, source: ProjectionSourceRow, record: IdentityRecord): IdentityReceipt["current_disposition"] {
  const current = db.query<{ current_revision: string }, [string]>("SELECT current_revision FROM memory_chunks WHERE memory_chunk_id=?").get(source.episode_id);
  if (current?.current_revision !== source.revision) return "source_superseded";
  const node = requireNode(db, record.literal_loser);
  if (node.identity_history_ref !== record.decision_ref) return "replaced_by_later_decision";
  return record.operation === "apply" ? "active" : "revoked";
}

function recordScopeStatus(db: Database, record: IdentityRecord, input: IdentityReadScope): { inScope: boolean; authoritative: boolean } {
  const bindings = [record.decision_source, record.loser_source, record.canonical_source]
    .filter((value): value is NormalizedIdentityEvidence => Boolean(value));
  if (!bindings.length || bindings.some((binding) => !bindingInScope(binding, input)))
    return { inScope: false, authoritative: false };
  return { inScope: true, authoritative: bindings.every((binding) => bindingCurrent(db, binding, input.butlerData)) };
}

function bindingInScope(binding: NormalizedIdentityEvidence, input: IdentityReadScope): boolean {
  if (!input.includeInternal && !["user_input", "assistant_public"].includes(binding.origin_kind)) return false;
  if (Date.parse(binding.observed_at) > Date.parse(input.asOf)) return false;
  if (input.scope === "current_session" && binding.session_id !== input.currentSessionId) return false;
  if (input.scope === "current_project" && binding.project_id !== input.currentProjectId) return false;
  if (input.sessionIds.length && !input.sessionIds.includes(binding.session_id)) return false;
  if (input.projectFilter === "unassigned" && binding.project_id !== null) return false;
  if (input.projectFilter === "selected" && (binding.project_id === null || !input.projectIds.includes(binding.project_id))) return false;
  return true;
}

function bindingCurrent(db: Database, binding: NormalizedIdentityEvidence, butlerData: string): boolean {
  const source = sourceRows(db, [binding.source_ref])[0];
  if (!source || source.episode_id !== binding.episode_id || source.revision !== binding.revision ||
    source.content_hash !== binding.content_hash || source.byte_start !== binding.byte_start || source.byte_end !== binding.byte_end ||
    source.conversation_session_id !== binding.session_id || source.origin_kind !== binding.origin_kind ||
    source.role !== binding.role || source.observed_at !== binding.observed_at) return false;
  const chunk = db.query<{ current_revision: string; project_id: string | null }, [string]>(
    "SELECT current_revision,project_id FROM memory_chunks WHERE memory_chunk_id=?",
  ).get(binding.episode_id);
  if (!chunk || chunk.current_revision !== binding.revision || chunk.project_id !== binding.project_id) return false;
  try {
    assertCanonicalProjectionSourcesCurrent(butlerData, db, [source]);
    const hydrated = hydrateSource(butlerData, source).text;
    if (!binding.quote) return true;
    const localStart = binding.quote_byte_start - binding.byte_start;
    const localEnd = binding.quote_byte_end - binding.byte_start;
    return Buffer.from(hydrated).subarray(localStart, localEnd).toString("utf8") === binding.quote;
  } catch { return false; }
}

function resolveAuthorizedPreimage(
  db: Database,
  literal: string,
  record: IdentityRecord,
  input: IdentityReadScope,
  visited: Set<string>,
): { nodeId: string; partial: boolean } {
  const restored = record.resulting_direct_redirect;
  if (!restored) return { nodeId: literal, partial: false };
  if (!record.target_decision) return { nodeId: literal, partial: true };
  const target = findRecord(db, record.target_decision.job_ref, record.target_decision.decision_ref);
  if (!target?.previous_head) return { nodeId: literal, partial: true };
  const previous = findOwningApplyForState(db, target.previous_head, restored);
  if (!previous) return { nodeId: literal, partial: true };
  const scope = recordScopeStatus(db, previous, input);
  if (!scope.inScope || !scope.authoritative)
    return { nodeId: literal, partial: true };
  if (visited.size >= 64 || Date.now() >= input.deadlineAt) return { nodeId: literal, partial: true };
  return resolveIdentityAtInternal(db, restored, input, visited);
}

function findOwningApplyForState(
  db: Database,
  initial: IdentityHistoryRef,
  directRedirect: string,
): IdentityRecord | null {
  let head: IdentityHistoryRef | null = initial;
  const visited = new Set<string>();
  while (head && visited.size < 64) {
    const key = `${head.job_ref}\0${head.decision_ref}`;
    if (visited.has(key)) return null;
    visited.add(key);
    const record = findRecord(db, head.job_ref, head.decision_ref);
    if (!record) return null;
    if (record.operation === "apply" && record.resulting_direct_redirect === directRedirect) return record;
    if ((record.operation === "revoke" || record.operation === "invalidate") && record.resulting_direct_redirect === directRedirect && record.target_decision) {
      const target = findRecord(db, record.target_decision.job_ref, record.target_decision.decision_ref);
      head = target?.previous_head ?? null;
    } else head = record.previous_head;
  }
  return null;
}

function receipt(db: Database, operation: IdentityCommand["operation"], sourceJob: string, decisionRef: string | null, outcome: string,
  disposition: IdentityReceipt["current_disposition"], replayed: boolean, extra: Partial<IdentityReceipt> = {}): IdentityReceipt {
  return { ok: true, operation, source_job_ref: sourceJob, decision_ref: decisionRef, recorded_outcome: outcome,
    current_disposition: disposition, replayed, graph_revision: Number(db.query<{ value: string }, []>("SELECT value FROM memory_state WHERE key='graph_revision'").get()?.value ?? 0),
    pending_projection_counts: {
      node_vectors: Number(db.query<{ count: number }, []>("SELECT COUNT(*) count FROM memory_vector_units WHERE record_kind='node' AND state='pending'").get()?.count ?? 0),
      hot_cache: Number(db.query<{ count: number }, []>("SELECT COUNT(*) count FROM memory_projection_jobs WHERE json_extract(hot_cache_state,'$.state')='pending'").get()?.count ?? 0),
    }, ...extra };
}

function validateCommand(command: IdentityCommand): void {
  if (!command || command.schema !== "butler.memory-identity-command.v1" || !["inspect", "apply", "revoke"].includes(command.operation)) throw new Error("memory_identity_invalid_command");
  if (command.operation !== "inspect" && (!("operation_id" in command) || !/^[\x21-\x7e]{1,64}$/u.test(command.operation_id)))
    throw new Error("memory_identity_invalid_command");
  const allowed = command.operation === "inspect"
    ? ["schema", "expected_generation", "operation", "source_ref", "node_refs"]
    : command.operation === "apply"
      ? ["schema", "expected_generation", "operation", "operation_id", "decision", "reason", "source", "loser_node_ref", "canonical_node_ref", "loser_evidence", "canonical_evidence", "expected_loser", "expected_canonical"]
      : ["schema", "expected_generation", "operation", "operation_id", "source", "decision_job_ref", "decision_ref", "expected_loser"];
  if (Object.keys(command).some((key) => !allowed.includes(key))) throw new Error("memory_identity_invalid_command");
  if (typeof command.expected_generation !== "string" || !command.expected_generation) throw new Error("memory_identity_invalid_command");
  if (command.operation === "inspect") {
    if (typeof command.source_ref !== "string" || !command.source_ref || !Array.isArray(command.node_refs) || command.node_refs.length !== 2 ||
      command.node_refs.some((value) => typeof value !== "string" || !value)) throw new Error("memory_identity_invalid_command");
    return;
  }
  validateIdentityQuote(command.source);
  validateExpectedState(command.expected_loser);
  if (command.operation === "apply") {
    if (command.decision !== "same_entity" || !["explicit_alias", "explicit_identity_correction"].includes(command.reason) ||
      !command.loser_node_ref || !command.canonical_node_ref) throw new Error("memory_identity_invalid_command");
    validateIdentityQuote(command.loser_evidence);
    validateIdentityQuote(command.canonical_evidence);
    validateExpectedState(command.expected_canonical);
  } else if (!command.decision_job_ref || !command.decision_ref) throw new Error("memory_identity_invalid_command");
}

function validateIdentityQuote(value: IdentityQuote): void {
  if (!value || Object.keys(value).some((key) => !["source_ref", "quote", "occurrence"].includes(key)) ||
    typeof value.source_ref !== "string" || !value.source_ref || typeof value.quote !== "string" || !value.quote ||
    !Number.isSafeInteger(value.occurrence) || value.occurrence < 0) throw new Error("memory_identity_invalid_command");
}

function validateExpectedState(value: ExpectedIdentityState): void {
  if (!value || Object.keys(value).some((key) => !["direct_redirect", "resolved_node_ref", "history_head"].includes(key)) ||
    (value.direct_redirect !== null && typeof value.direct_redirect !== "string") || !value.resolved_node_ref ||
    (value.history_head !== null && (!value.history_head || Object.keys(value.history_head).some((key) => !["job_ref", "decision_ref"].includes(key)) ||
      !value.history_head.job_ref || !value.history_head.decision_ref))) throw new Error("memory_identity_invalid_command");
}

function findLiteralOrNfcOccurrence(text: string, quote: string, occurrence: number): { start: number; end: number } | null {
  let from = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = text.indexOf(quote, from);
    if (found < 0) break;
    if (index === occurrence) return { start: found, end: found + quote.length };
    from = found + quote.length;
  }
  const segments = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)];
  let seen = 0;
  for (let start = 0; start < segments.length; start += 1) {
    for (let end = start + 1; end <= segments.length; end += 1) {
      const rawStart = segments[start]!.index;
      const rawEnd = end < segments.length ? segments[end]!.index : text.length;
      if (text.slice(rawStart, rawEnd).normalize("NFC") === quote.normalize("NFC") && seen++ === occurrence)
        return { start: rawStart, end: rawEnd };
    }
  }
  return null;
}

function graphemeCount(value: string): number { return [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)].length; }
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
