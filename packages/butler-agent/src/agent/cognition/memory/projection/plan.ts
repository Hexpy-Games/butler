import { mapCondition } from "./meaning.ts";
import { randomUUID } from "node:crypto";
import {
  MEMORY_EXTRACTION_VERSION,
  type ExtractInput,
  type ExtractOutput,
  type QuoteRef,
} from "./contracts.ts";
import { openProjectionDb, refreshSemanticState, sourceRows } from "./store.ts";
import { graphemeCount, unicodeCaseFold, unicodeNfc } from "./unicode.ts";
import { assertCanonicalProjectionSourcesCurrent, projectionHash } from "./source.ts";
import { resolveIdentityForProjectionInput } from "./identity.ts";
import { createContextEvidenceResolver } from "./context-evidence.ts";

export type NormalizedPlan = {
  refs: Record<string, string>;
  evidence: Record<
    string,
    Array<{
      sourceId: string;
      byteStart: number;
      byteEnd: number;
      quote: string;
    }>
  >;
  candidate_bindings: Record<string, {
    node_ref: string;
    type: string;
    scope: "user" | "project";
    project_id: string | null;
    evidence: Array<{ source_ref: string; episode_ref: string; revision: string; content_hash: string }>;
  }>;
};
export function normalizeAndValidatePlan(
  db: ReturnType<typeof openProjectionDb>,
  input: ExtractInput,
  output: ExtractOutput,
): NormalizedPlan {
  if (output.disposition === "unsupported") return { refs: {}, evidence: {}, candidate_bindings: {} };
  const refs: Record<string, string> = {};
  const candidate_bindings: NormalizedPlan["candidate_bindings"] = {};
  const bindingCandidates = new Map<string, ExtractInput["candidates"][number]>();
  const candidates = new Map(input.candidates.map((c) => [c.ref, c]));
  for (const item of output.nodes) {
    if (graphemeCount(item.label) > 256)
      throw new Error("memory_extract_invalid_output");
    if (item.resolution.kind === "reuse") {
      const candidate = candidates.get(item.resolution.node_ref);
      if (
        !candidate ||
        candidate.type !== item.type ||
        (candidate.scope === "project" &&
          candidate.project_id !== input.bound_project_id)
      )
        throw new Error("memory_extract_invalid_identity_reuse");
      validateReuseEvidence(input, candidate, item.resolution.evidence);
      refs[item.local_ref] = candidate.ref;
      bindingCandidates.set(item.local_ref, candidate);
    } else {
      if (
        item.resolution.identity_scope === "project" &&
        !input.bound_project_id
      )
        throw new Error("memory_extract_invalid_scope");
      refs[item.local_ref] = randomUUID();
    }
  }
  for (const claim of output.claims) {
    if (graphemeCount(claim.statement) > 1024)
      throw new Error("memory_extract_invalid_output");
    if (claim.resolution.kind === "reuse") {
      const candidate = candidates.get(claim.resolution.node_ref);
      if (
        !candidate ||
        candidate.type !== claim.type ||
        !claimCandidateAllowed(candidate, input.bound_project_id)
      ) {
        throw new Error("memory_extract_invalid_identity_reuse");
      }
      validateReuseEvidence(input, candidate, claim.resolution.evidence);
      refs[claim.local_ref] = candidate.ref;
      bindingCandidates.set(claim.local_ref, candidate);
    } else {
      // Claim scope is deliberately ignored here. Runtime derives it from the canonical source binding.
      refs[claim.local_ref] = randomUUID();
    }
  }
  const evidence: NormalizedPlan["evidence"] = {};
  for (const item of [...output.nodes, ...output.claims])
    evidence[item.local_ref] = validateQuotes(input, item.evidence, true);
  for (const node of output.nodes)
    if (node.aliases.length > 8)
      throw new Error("memory_extract_invalid_output");
  for (const node of output.nodes)
    for (const alias of node.aliases) {
      if (graphemeCount(alias.text) > 256)
        throw new Error("memory_extract_invalid_output");
      validateQuotes(input, alias.evidence, true);
    }
  const claims = new Map(output.claims.map((c) => [c.local_ref, c]));
  for (const claim of output.claims) {
    if (claim.condition && graphemeCount(claim.condition) > 1024)
      throw new Error("memory_extract_invalid_output");
    if (
      (claim.subject_ref && !refs[claim.subject_ref]) ||
      (claim.object_ref && !refs[claim.object_ref])
    )
      throw new Error("memory_extract_invalid_ref");
    if (claim.requirement) {
      if (output.schema !== "butler.memory-extract-output.v3" || claim.type !== "constraint" || !claim.subject_ref || !claim.requirement.action.trim())
        throw new Error("memory_extract_invalid_condition");
      let atoms = 0;
      mapCondition(claim.requirement.condition, (ref) => {
        if (!refs[ref] || ++atoms > 16) throw new Error("memory_extract_invalid_ref");
        return refs[ref]!;
      });
    }
    assertBasis(input, claim.basis, claim.evidence);
  }
  for (const relation of output.relations) {
    const claim = claims.get(relation.claim_ref);
    if (
      !claim ||
      claim.speech_act !== "assertion" ||
      claim.subject_ref !== relation.from_ref ||
      claim.object_ref !== relation.to_ref
    )
      throw new Error("memory_extract_invalid_relation");
    validateQuotes(input, relation.evidence, true);
  }
  for (const correction of output.corrections) {
    const previousClaim = candidates.get(correction.previous_claim_ref);
    if (
      !previousClaim ||
      !isClaimType(previousClaim.type) ||
      !claimCandidateAllowed(previousClaim, input.bound_project_id) ||
      !claims.has(correction.replacement_claim_ref)
    ) {
      throw new Error("memory_extract_invalid_ref");
    }
    validateQuotes(input, correction.evidence, true);
    bindingCandidates.set(`correction:${correction.previous_claim_ref}`, previousClaim);
    const replacement = claims.get(correction.replacement_claim_ref)!;
    const previousSubject = db.query<{ target_node_id: string }, [string]>("SELECT target_node_id FROM edges WHERE source_node_id=? AND rel_type='has_subject' ORDER BY edge_id LIMIT 1").get(previousClaim.ref)?.target_node_id ?? null;
    const replacementSubject = replacement.subject_ref ? refs[replacement.subject_ref] ?? null : null;
    const previousRelation = db.query<{ rel_type: string }, [string]>("SELECT rel_type FROM edges WHERE claim_node_id=? AND rel_type NOT IN ('has_subject','has_object','supersedes','contradicts','condition_member') ORDER BY edge_id LIMIT 1").get(previousClaim.ref)?.rel_type ?? null;
    const replacementRelation = output.relations.find((relation) => relation.claim_ref === replacement.local_ref)?.relation ?? null;
    const previousProperties = db.query<{ properties: string; type: string }, [string]>("SELECT properties,type FROM entities WHERE id=?").get(previousClaim.ref);
    const previousCondition = previousProperties ? (JSON.parse(previousProperties.properties) as { condition?: string | null }).condition ?? null : null;
    if (!previousProperties || previousProperties.type !== replacement.type || previousSubject !== replacementSubject || previousRelation !== replacementRelation || previousCondition !== replacement.condition)
      throw new Error("memory_extract_invalid_correction");
  }
  if (output.summary) {
    if (graphemeCount(output.summary.text) > 480)
      throw new Error("memory_extract_invalid_output");
    validateQuotes(input, output.summary.evidence, true);
  }
  for (const [key, candidate] of bindingCandidates) candidate_bindings[key] = candidateBinding(db, candidate);
  return { refs, evidence, candidate_bindings };
}

function candidateBinding(
  db: ReturnType<typeof openProjectionDb>,
  candidate: ExtractInput["candidates"][number],
): NormalizedPlan["candidate_bindings"][string] {
  const rows = sourceRows(db, candidate.evidence.map((item) => item.ref));
  if (rows.length !== candidate.evidence.length) throw new Error("memory_extract_candidate_changed");
  return {
    node_ref: candidate.ref,
    type: candidate.type,
    scope: candidate.scope,
    project_id: candidate.project_id,
    evidence: rows.map((row) => ({ source_ref: row.source_id, episode_ref: row.episode_id, revision: row.revision, content_hash: row.content_hash }))
      .sort((a, b) => a.source_ref.localeCompare(b.source_ref)),
  };
}

function claimCandidateAllowed(
  candidate: ExtractInput["candidates"][number],
  boundProjectId: string | null,
): boolean {
  return boundProjectId
    ? candidate.scope === "project" &&
        candidate.project_id === boundProjectId
    : candidate.scope === "user" && candidate.project_id === null;
}

function isClaimType(type: ExtractInput["candidates"][number]["type"]): boolean {
  return [
    "preference",
    "goal",
    "constraint",
    "decision",
    "memory_atom",
  ].includes(type);
}

export function applyPlan(
  db: ReturnType<typeof openProjectionDb>,
  jobId: string,
  windowRef: string,
  input: ExtractInput,
  output: ExtractOutput,
  plan: NormalizedPlan,
  candidateResolutions: Record<string, string>,
  sourceRoot: string,
): void {
  db.transaction(() => {
    if (output.disposition === "unsupported") {
      db.query(
        "UPDATE memory_projection_windows SET state='unsupported',error_code=NULL,owner_pid=NULL,owner_nonce=NULL,started_at=NULL WHERE window_ref=?",
      ).run(windowRef);
      refreshSemanticState(db, jobId);
      return;
    }
    const now = new Date().toISOString();
    const resolveContextEvidence = createContextEvidenceResolver(db, sourceRoot, input);
    const resolvedEvidence = Object.fromEntries(Object.entries(plan.evidence).map(([ref, evidence]) =>
      [ref, evidence.flatMap(resolveContextEvidence)]));
    const refs = { ...plan.refs };
    for (const node of output.nodes) {
      if (node.resolution.kind !== "reuse") continue;
      const resolved = candidateResolutions[refs[node.local_ref]!];
      if (!resolved) throw new Error("memory_extract_candidate_changed");
      refs[node.local_ref] = resolved;
    }
    const sourceByRef = new Map(
      sourceRows(
        db,
        [...new Set([...input.source_units.map((unit) => unit.ref),
          ...Object.values(resolvedEvidence).flatMap((evidence) => evidence.map((item) => item.sourceId))])],
      ).map((row) => [row.source_id, row]),
    );
    const upsertNode = (
      localRef: string,
      type: string,
      label: string,
      resolution: { kind: string; identity_scope?: string },
    ) => {
      const id = refs[localRef];
      if (resolution.kind === "create") {
        if (!resolution.identity_scope)
          throw new Error("memory_extract_invalid_scope");
        db.query(
          "INSERT OR IGNORE INTO entities(id,type,label_original,properties,identity_scope,project_id,created_at) VALUES(?,?,?,?,?,?,?)",
        ).run(
          id,
          type,
          label,
          "{}",
          resolution.identity_scope,
          resolution.identity_scope === "project"
            ? input.bound_project_id
            : null,
          now,
        );
      }
      for (const ev of resolvedEvidence[localRef] ?? []) {
        const row = sourceByRef.get(ev.sourceId);
        if (!row) continue;
        db.query(
          "INSERT OR IGNORE INTO entity_mentions(entity_id,source_id,episode_id,revision) VALUES(?,?,?,?)",
        ).run(id, row.source_id, row.episode_id, row.revision);
      }
    };
    for (const node of output.nodes) {
      upsertNode(node.local_ref, node.type, node.label, node.resolution);
      const aliases = [
        { text: node.label, evidence: node.evidence },
        ...node.aliases,
      ];
      for (const alias of aliases)
        for (const ev of validateQuotes(input, alias.evidence, true).flatMap(resolveContextEvidence)) {
          db.query(
            "INSERT OR IGNORE INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?,?,?,?,?,?)",
          ).run(
            refs[node.local_ref],
            alias.text,
            unicodeNfc(alias.text),
            unicodeCaseFold(alias.text),
            ev.sourceId,
            node.resolution.kind,
          );
        }
    }
    for (const claim of output.claims) {
      const runtimeResolution =
        claim.resolution.kind === "create"
          ? {
              ...claim.resolution,
              identity_scope: input.bound_project_id
                ? ("project" as const)
                : ("user" as const),
            }
          : claim.resolution;
      upsertNode(
        claim.local_ref,
        claim.type,
        claim.statement,
        runtimeResolution,
      );
      if (claim.resolution.kind === "create") {
        db.query("UPDATE entities SET properties=? WHERE id=?").run(
          JSON.stringify({
            statement: claim.statement,
            speech_act: claim.speech_act,
            basis: claim.basis,
            polarity: claim.polarity,
            condition: claim.condition,
            ...(claim.requirement ? { requirement: { action: claim.requirement.action,
              condition: mapCondition(claim.requirement.condition, (ref) => refs[ref]!) } } : {}),
            valid_from: claim.valid_from,
            valid_to: claim.valid_to,
            salience: claim.salience,
          }),
          refs[claim.local_ref],
        );
      }
      for (const ev of resolvedEvidence[claim.local_ref] ?? []) {
        db.query(
          "INSERT OR IGNORE INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?,?,?,?,?,?)",
        ).run(
          refs[claim.local_ref],
          claim.statement,
          unicodeNfc(claim.statement),
          unicodeCaseFold(claim.statement),
          ev.sourceId,
          claim.resolution.kind,
        );
      }
      if (claim.subject_ref)
        addEdge(
          "has_subject",
          claim.local_ref,
          claim.subject_ref,
          claim.local_ref,
          claim.evidence,
          claim.basis,
        );
      if (claim.requirement) {
        const members = new Set<string>();
        mapCondition(claim.requirement.condition, (ref) => { members.add(ref); return ref; });
        for (const ref of members) addEdge("condition_member", claim.local_ref, ref, claim.local_ref, claim.evidence, claim.basis);
      }
      if (claim.object_ref)
        addEdge(
          "has_object",
          claim.local_ref,
          claim.object_ref,
          claim.local_ref,
          claim.evidence,
          claim.basis,
        );
    }
    for (const relation of output.relations) {
      const claim = output.claims.find(
        (c) => c.local_ref === relation.claim_ref,
      )!;
      addEdge(
        relation.relation,
        relation.from_ref,
        relation.to_ref,
        relation.claim_ref,
        relation.evidence,
        claim.basis,
      );
    }
    for (const correction of output.corrections) {
      const replacement = output.claims.find((claim) => claim.local_ref === correction.replacement_claim_ref);
      const replacementId = refs[correction.replacement_claim_ref];
      if (!replacement || !replacementId) throw new Error("memory_extract_invalid_correction");
      const edgeId = projectionHash(["memory-edge", replacementId, correction.previous_claim_ref, correction.relation, replacementId]);
      db.query("INSERT OR IGNORE INTO edges(edge_id,source_node_id,target_node_id,rel_type,claim_node_id,qualifiers,valid_from) VALUES(?,?,?,?,?,?,?)")
        .run(edgeId, replacementId, correction.previous_claim_ref, correction.relation, replacementId,
          JSON.stringify({ effective_at: correction.effective_at }), correction.effective_at);
      for (const ev of validateQuotes(input, correction.evidence, true).flatMap(resolveContextEvidence))
        db.query("INSERT OR IGNORE INTO edge_evidence(edge_id,chunk_source_id,basis,extraction_version) VALUES(?,?,?,?)")
          .run(edgeId, ev.sourceId, replacement.basis, MEMORY_EXTRACTION_VERSION);
    }
    if (output.summary) {
      const summaries = db.query<{ window_ref: string; state: string; output_json: string | null }, [string]>(
        "SELECT window_ref,state,output_json FROM memory_projection_windows WHERE job_id=? ORDER BY ordinal",
      ).all(jobId).flatMap((row) => {
        if (row.window_ref !== windowRef && row.state !== "complete") return [];
        try {
          const text = (JSON.parse(row.output_json ?? "null") as ExtractOutput | null)?.summary?.text;
          return text ? [text] : [];
        } catch { return []; }
      });
      const summary = summaries.join("\n\n");
      const previous = db.query<{ summary: string }, [string]>("SELECT summary FROM memory_chunks WHERE memory_chunk_id=?").get(input.episode_ref)?.summary ?? "";
      db.query("UPDATE memory_chunks SET summary=?,summary_status='complete' WHERE memory_chunk_id=?").run(summary, input.episode_ref);
      if (summary !== previous) db.query("UPDATE memory_projection_jobs SET hot_cache_state=?,hot_cache_receipt_json=NULL,hot_cache_next_attempt_at=NULL WHERE job_id=?")
        .run(JSON.stringify({ state: "pending", blocked_by: null }), jobId);
    }
    db.query(
      "UPDATE memory_projection_windows SET state='complete',error_code=NULL,owner_pid=NULL,owner_nonce=NULL,started_at=NULL WHERE window_ref=?",
    ).run(windowRef);
    const attempt = db.query<{ attempt_count: number; recovery_revision: string | null; input_sha256: string | null; output_json: string | null; provider_evidence_json: string | null }, [string]>(
      "SELECT attempt_count,recovery_revision,input_sha256,output_json,provider_evidence_json FROM memory_projection_windows WHERE window_ref=?",
    ).get(windowRef);
    if (attempt) db.query(`INSERT OR REPLACE INTO memory_projection_attempts
      (attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,output_json,provider_evidence_json,recorded_at,attempt_kind,provider_invoked,outcome_known,recovery_revision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`${windowRef}:attempt:${attempt.attempt_count}:complete`, windowRef, jobId,
        attempt.attempt_count, "complete", null, attempt.input_sha256, null, null, new Date().toISOString(), "apply", 0, 1, attempt.recovery_revision);
    db.query(
      "UPDATE memory_state SET value=CAST(value AS INTEGER)+1 WHERE key='graph_revision'",
    ).run();
    refreshSemanticState(db, jobId);
    function addEdge(
      rel: string,
      from: string,
      to: string,
      claim: string,
      evidence: QuoteRef[],
      basis: string,
    ) {
      const fromId = refs[from],
        toId = refs[to],
        claimId = refs[claim];
      if (!fromId || !toId || !claimId)
        throw new Error("memory_extract_invalid_ref");
      const edgeId = projectionHash([
        "memory-edge",
        fromId,
        toId,
        rel,
        claimId,
      ]);
      db.query(
        "INSERT OR IGNORE INTO edges(edge_id,source_node_id,target_node_id,rel_type,claim_node_id,qualifiers) VALUES(?,?,?,?,?,'{}')",
      ).run(edgeId, fromId, toId, rel, claimId);
      for (const ev of validateQuotes(input, evidence, true).flatMap(resolveContextEvidence))
        db.query(
          "INSERT OR IGNORE INTO edge_evidence(edge_id,chunk_source_id,basis,extraction_version) VALUES(?,?,?,?)",
        ).run(edgeId, ev.sourceId, basis, MEMORY_EXTRACTION_VERSION);
    }
  })();
}

function validateQuotes(
  input: ExtractInput,
  quotes: QuoteRef[],
  requireCurrent: boolean,
): Array<{
  sourceId: string;
  byteStart: number;
  byteEnd: number;
  quote: string;
}> {
  if (!Array.isArray(quotes) || quotes.length > 4)
    throw new Error("memory_extract_invalid_quote");
  const units = new Map(
    [
      ...input.source_units,
      ...input.context_units,
      ...input.candidates.flatMap((c) => c.evidence),
    ].map((unit) => [unit.ref, unit.text]),
  );
  const current = new Set(input.source_units.map((unit) => unit.ref));
  const result = quotes.map((q) => {
    const text = units.get(q.unit_ref);
    if (
      typeof text !== "string" ||
      !q.quote ||
      graphemeCount(q.quote) > 480 ||
      !Number.isInteger(q.occurrence) ||
      q.occurrence < 0
    )
      throw new Error("memory_extract_invalid_quote");
    const span = findQuote(text, q.quote, q.occurrence);
    if (!span) throw new Error("memory_extract_invalid_quote");
    return {
      sourceId: q.unit_ref,
      byteStart: Buffer.byteLength(text.slice(0, span.start)),
      byteEnd: Buffer.byteLength(text.slice(0, span.end)),
      quote: text.slice(span.start, span.end),
    };
  });
  if (requireCurrent && !result.some((item) => {
    if (current.has(item.sourceId)) return true;
    const span = input.context_units.find((unit) => unit.ref === item.sourceId)?.source_span;
    return span && current.has(span.source_ref) && item.byteStart < span.prefix_bytes + span.focus_end - span.focus_start && item.byteEnd > span.prefix_bytes;
  }))
    throw new Error("memory_extract_invalid_quote");
  return result;
}

function findQuote(
  text: string,
  quote: string,
  occurrence: number,
): { start: number; end: number } | null {
  let from = 0,
    index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = text.indexOf(quote, from);
    if (index < 0) break;
    from = index + quote.length;
  }
  if (index >= 0) return { start: index, end: index + quote.length };
  const segments = [
    ...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text),
  ];
  let seen = 0;
  for (let start = 0; start < segments.length; start++)
    for (let end = start + 1; end <= segments.length; end++) {
      const rawStart = segments[start].index,
        rawEnd = end < segments.length ? segments[end].index : text.length;
      if (unicodeNfc(text.slice(rawStart, rawEnd)) === unicodeNfc(quote)) {
        if (seen++ === occurrence) return { start: rawStart, end: rawEnd };
      }
    }
  return null;
}
function assertBasis(
  input: ExtractInput,
  basis: string,
  evidence: QuoteRef[],
): void {
  const units = new Map(input.source_units.map((unit) => [unit.ref, unit]));
  for (const q of evidence) {
    const span = input.context_units.find((entry) => entry.ref === q.unit_ref)?.source_span;
    const unit = units.get(span?.source_ref ?? q.unit_ref);
    if (!unit) continue;
    if (
      (basis === "user_statement" &&
        unit.role !== "user" && unit.role !== "explicit") ||
      (basis === "assistant_statement" && unit.role !== "assistant") ||
      (basis === "reviewed_task" && unit.role !== "task") ||
      (unit.role === "explicit" && basis !== "user_statement")
    )
      throw new Error("memory_extract_invalid_basis");
  }
}

function validateReuseEvidence(
  input: ExtractInput,
  candidate: ExtractInput["candidates"][number],
  evidence: QuoteRef[],
): void {
  const validated = validateQuotes(input, evidence, true);
  const candidateRefs = new Set(candidate.evidence.map((item) => item.ref));
  if (!validated.some((item) => candidateRefs.has(item.sourceId))) {
    throw new Error("memory_extract_invalid_identity_reuse");
  }
}

export function assertPlanSourceCurrent(
  db: ReturnType<typeof openProjectionDb>,
  input: ExtractInput,
): void {
  const chunk = db
    .query<
      { current_revision: string },
      [string]
    >("SELECT current_revision FROM memory_chunks WHERE memory_chunk_id=?")
    .get(input.episode_ref);
  const rows = sourceRows(
    db,
    input.source_units.map((unit) => unit.ref),
  );
  if (
    !chunk ||
    chunk.current_revision !== input.revision ||
    rows.length !== input.source_units.length ||
    rows.some((row) => row.revision !== input.revision)
  ) {
    throw new Error("memory_source_changed");
  }
}

export function assertPlanCandidatesCurrent(
  db: ReturnType<typeof openProjectionDb>,
  butlerData: string,
  input: ExtractInput,
  plan: NormalizedPlan,
): Record<string, string> {
  const resolutions: Record<string, string> = {};
  for (const binding of Object.values(plan.candidate_bindings ?? {})) {
    const entity = db.query<{ type: string; identity_scope: string; project_id: string | null; canonical_node_id: string | null }, [string]>(
      "SELECT type,identity_scope,project_id,canonical_node_id FROM entities WHERE id=?",
    ).get(binding.node_ref);
    if (!entity || entity.type !== binding.type || entity.identity_scope !== binding.scope || entity.project_id !== binding.project_id)
      throw new Error("memory_extract_candidate_changed");
    const resolved = resolveIdentityForProjectionInput(db, butlerData, input, binding.node_ref);
    if (resolved.partial) throw new Error("memory_extract_candidate_changed");
    const current = db.query<{ type: string; identity_scope: string; project_id: string | null }, [string]>(
      "SELECT type,identity_scope,project_id FROM entities WHERE id=?",
    ).get(resolved.nodeId);
    if (!current || current.type !== binding.type || current.identity_scope !== binding.scope || current.project_id !== binding.project_id)
      throw new Error("memory_extract_candidate_changed");
    const rows = sourceRows(db, binding.evidence.map((item) => item.source_ref));
    if (rows.length !== binding.evidence.length) throw new Error("memory_extract_candidate_changed");
    for (const evidence of binding.evidence) {
      const row = rows.find((item) => item.source_id === evidence.source_ref);
      if (!row || row.episode_id !== evidence.episode_ref || row.revision !== evidence.revision || row.content_hash !== evidence.content_hash)
        throw new Error("memory_extract_candidate_changed");
      const eligible = db.query<{ found: number }, [string, string, string | null, string, string | null]>(`
        SELECT 1 found FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
        WHERE s.source_id=? AND c.status='active'
          AND ((?='project' AND c.project_id IS ?) OR (?='user' AND (c.project_id IS NULL OR c.project_id IS ?))) LIMIT 1
      `).get(evidence.source_ref, binding.scope, binding.project_id, binding.scope, input.bound_project_id);
      if (!eligible) throw new Error("memory_extract_candidate_changed");
    }
    try { assertCanonicalProjectionSourcesCurrent(butlerData, db, rows); }
    catch { throw new Error("memory_extract_candidate_changed"); }
    resolutions[binding.node_ref] = resolved.nodeId;
  }
  return resolutions;
}

/** Use the same quote validation and canonical mapping as graph persistence. */
export function resolveSummaryEvidenceSources(
  db: ReturnType<typeof openProjectionDb>, sourceRoot: string, input: ExtractInput, evidence: QuoteRef[],
): string[] {
  const resolve = createContextEvidenceResolver(db, sourceRoot, input);
  return [...new Set(validateQuotes(input, evidence, true).flatMap(resolve).map((quote) => quote.sourceId))];
}

export function safeProjectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("memory_write_busy")) return "memory_write_busy";
  if (["memory_extract_input_exceeds_budget", "memory_extract_source_window_exceeds_budget", "memory_extract_output_exceeds_budget"].includes(message)) return message;
  if (message.startsWith("memory_extract_invalid_") || ["memory_extract_needs_context", "memory_extract_unsupported", "memory_extract_correction_unresolved", "memory_extract_binding_oversize", "memory_extract_candidate_changed", "memory_extract_stage_changed"].includes(message)) return message;
  if (
    message === "memory_source_changed" ||
    message === "memory_generation_changed" ||
    message === "memory_extract_corrections_unsupported"
  )
    return message;
  if (message.includes("abort")) return "memory_extract_timeout";
  return "memory_extract_provider_failed";
}
