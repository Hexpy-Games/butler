import { randomUUID } from "node:crypto";
import {
  MEMORY_EXTRACTION_VERSION,
  type ExtractInput,
  type ExtractOutput,
  type QuoteRef,
} from "./contracts.ts";
import { openProjectionDb, refreshSemanticState, sourceRows } from "./store.ts";
import { graphemeCount, unicodeCaseFold, unicodeNfc } from "./unicode.ts";
import { projectionHash } from "./source.ts";

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
};
export function normalizeAndValidatePlan(
  db: ReturnType<typeof openProjectionDb>,
  input: ExtractInput,
  output: ExtractOutput,
): NormalizedPlan {
  if (output.disposition === "unsupported") return { refs: {}, evidence: {} };
  const refs: Record<string, string> = {};
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
  }
  if (output.corrections.length > 0) {
    throw new Error("memory_extract_corrections_unsupported");
  }
  if (output.summary) {
    if (graphemeCount(output.summary.text) > 480)
      throw new Error("memory_extract_invalid_output");
    validateQuotes(input, output.summary.evidence, true);
  }
  return { refs, evidence };
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
): void {
  db.transaction(() => {
    if (output.disposition === "unsupported") {
      db.query(
        "UPDATE memory_projection_windows SET state='unsupported',error_code='semantic_unsupported' WHERE window_ref=?",
      ).run(windowRef);
      refreshSemanticState(db, jobId);
      return;
    }
    const now = new Date().toISOString();
    const sourceByRef = new Map(
      sourceRows(
        db,
        input.source_units.map((unit) => unit.ref),
      ).map((row) => [row.source_id, row]),
    );
    const upsertNode = (
      localRef: string,
      type: string,
      label: string,
      resolution: { kind: string; identity_scope?: string },
    ) => {
      const id = plan.refs[localRef];
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
      for (const ev of plan.evidence[localRef] ?? []) {
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
        for (const ev of validateQuotes(input, alias.evidence, true)) {
          db.query(
            "INSERT OR IGNORE INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?,?,?,?,?,?)",
          ).run(
            plan.refs[node.local_ref],
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
      db.query("UPDATE entities SET properties=? WHERE id=?").run(
        JSON.stringify({
          statement: claim.statement,
          speech_act: claim.speech_act,
          basis: claim.basis,
          polarity: claim.polarity,
          condition: claim.condition,
          valid_from: claim.valid_from,
          valid_to: claim.valid_to,
          salience: claim.salience,
        }),
        plan.refs[claim.local_ref],
      );
      for (const ev of plan.evidence[claim.local_ref] ?? []) {
        db.query(
          "INSERT OR IGNORE INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?,?,?,?,?,?)",
        ).run(
          plan.refs[claim.local_ref],
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
    if (output.summary)
      db.query(
        "UPDATE memory_chunks SET summary=?,summary_status='complete' WHERE memory_chunk_id=?",
      ).run(output.summary.text, input.episode_ref);
    db.query(
      "UPDATE memory_projection_windows SET state='complete',error_code=NULL WHERE window_ref=?",
    ).run(windowRef);
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
      const fromId = plan.refs[from],
        toId = plan.refs[to],
        claimId = plan.refs[claim];
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
      for (const ev of validateQuotes(input, evidence, true))
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
  if (requireCurrent && !result.some((item) => current.has(item.sourceId)))
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
    const unit = units.get(q.unit_ref);
    if (!unit) continue;
    if (
      (basis === "user_statement" && unit.role !== "user") ||
      (basis === "assistant_statement" && unit.role !== "assistant")
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

export function safeProjectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("memory_extract_invalid_")) return message;
  if (
    message === "memory_source_changed" ||
    message === "memory_generation_changed" ||
    message === "memory_extract_corrections_unsupported"
  )
    return message;
  if (message.includes("abort")) return "memory_extract_timeout";
  return "memory_extract_provider_failed";
}
