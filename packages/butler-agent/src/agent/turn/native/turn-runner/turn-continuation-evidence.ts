import { safeOptionalPublicText, safeRelativePath } from "../../../output/evidence/transcript-sanitizers.ts";
import { structuredToolResultModelPreview } from "../../tool-result-model-preview.ts";
import type { TurnContextObservationRef } from "../../turn-continuation-context.ts";
import type { PublicWorkDecision, ToolAuditEntry } from "../output/tool-types.ts";
import { buildTurnRoundJournal, renderTurnRoundJournal } from "./turn-round-journal.ts";

const MAX_SEARCH_FRONTIERS = 3;
const MAX_CANDIDATES = 12;
const MAX_CANDIDATES_PER_SEARCH = 4;
const MAX_VERIFIED_READS = 2;
const MAX_READ_CONTENT_CHARS = 1_600;

interface SourceCandidate {
  path: string;
  line?: number;
  snippet?: string;
}

interface SearchFrontier {
  pattern: string;
  matchCount: number;
  truncated: boolean;
  candidates: SourceCandidate[];
  auditIndex: number;
}

interface VerifiedReadFrontier {
  path: string;
  startLine?: number;
  endLine?: number;
  truncated: boolean;
  content?: string;
  auditIndex: number;
}

export interface TurnContinuationEvidence {
  modelVisibleContent: string;
  refs: TurnContextObservationRef[];
}

export function buildTurnContinuationEvidence(input: {
  audit: readonly ToolAuditEntry[];
  publicDecisions: readonly PublicWorkDecision[];
}): TurnContinuationEvidence {
  const searches = searchFrontiers(input.audit);
  const reads = verifiedReadFrontiers(input.audit);
  const candidates = interleavedCandidates(searches);
  const latestSearchIndex = searches.at(-1)?.auditIndex ?? -1;
  const latestReadIndex = reads.at(-1)?.auditIndex ?? -1;
  const nextStep = candidates.length > 0 && latestReadIndex < latestSearchIndex
    ? {
      objective: "Verify an existing source candidate.",
      tool: "read_file",
      preferred_candidates: candidates.slice(0, 6).map(({ path, line }) => ({
        path,
        ...(line ? { line } : {}),
      })),
      reason: "The previous search block already established concrete source candidates.",
    }
    : reads.length > 0
    ? {
      objective: "Use the verified source evidence to satisfy the remaining contract deliverable.",
      tool: null,
      reason: "A source file has already been read after candidate discovery.",
    }
    : null;
  const latestDecision = input.publicDecisions.at(-1);
  const roundJournal = buildTurnRoundJournal(input);
  const payload = compactUndefined({
    schema_version: "butler.turn-continuation-evidence.v1",
    latest_public_decision: latestDecision
      ? compactUndefined({
        decision_id: latestDecision.decisionId,
        semantic_block_id: latestDecision.semanticBlockId,
        summary: boundedPublicText(latestDecision.summary, 360),
        rationale: boundedPublicText(latestDecision.rationale, 360),
        next_step: boundedPublicText(latestDecision.nextStep, 360),
        expected_effect: boundedPublicText(latestDecision.expectedEffect, 360),
        repeat_reason: latestDecision.repeatReason,
      })
      : undefined,
    search_frontier: searches.map((search) => ({
      pattern: search.pattern,
      match_count: search.matchCount,
      truncated: search.truncated,
      candidates: search.candidates,
    })),
    verified_reads: reads.map((read) => compactUndefined({
      path: read.path,
      start_line: read.startLine,
      end_line: read.endLine,
      truncated: read.truncated,
      content: read.content,
    })),
    round_journal: roundJournal,
    suggested_next_step: nextStep,
  });
  const hasEvidence = searches.length > 0 || reads.length > 0 || roundJournal.length > 0 || latestDecision;
  return {
    modelVisibleContent: hasEvidence
      ? [
        "Structured continuation evidence (bounded runtime state):",
        JSON.stringify(payload, null, 2),
        renderTurnRoundJournal(roundJournal),
        "Continue from this exact frontier when authoring the next small public decision.",
      ].join("\n")
      : "",
    refs: candidates.map((candidate, index) => ({
      kind: "source_candidate",
      id: `candidate-${index + 1}${candidate.line ? `:line-${candidate.line}` : ""}`,
      path: candidate.path,
    })),
  };
}

function searchFrontiers(audit: readonly ToolAuditEntry[]): SearchFrontier[] {
  const byPattern = new Map<string, SearchFrontier>();
  audit.forEach((entry, auditIndex) => {
    if (!entry.ok || entry.name !== "grep_files") return;
    const preview = structuredToolResultModelPreview({ toolName: entry.name, output: entry.result });
    if (!preview) return;
    const pattern = boundedPublicText(preview.pattern, 200);
    if (!pattern) return;
    const matches = Array.isArray(preview.matches) ? preview.matches : [];
    const candidates = uniqueCandidates(matches.flatMap((value) => {
      const match = record(value);
      const path = safeRelativePath(match?.path);
      if (!path) return [];
      const line = finitePositiveInteger(match?.line);
      const snippet = boundedPublicText(match?.text, 240);
      return [{
        path,
        ...(line ? { line } : {}),
        ...(snippet ? { snippet } : {}),
      }];
    })).slice(0, MAX_CANDIDATES_PER_SEARCH);
    if (candidates.length === 0 && Array.isArray(preview.candidate_paths)) {
      candidates.push(...preview.candidate_paths.flatMap((value) => {
        const path = safeRelativePath(value);
        return path ? [{ path }] : [];
      }).slice(0, MAX_CANDIDATES_PER_SEARCH));
    }
    byPattern.set(pattern, {
      pattern,
      matchCount: finiteNonNegativeInteger(preview.match_count) ?? candidates.length,
      truncated: preview.truncated === true,
      candidates,
      auditIndex,
    });
  });
  return [...byPattern.values()]
    .sort((a, b) => a.auditIndex - b.auditIndex)
    .slice(-MAX_SEARCH_FRONTIERS);
}

function verifiedReadFrontiers(audit: readonly ToolAuditEntry[]): VerifiedReadFrontier[] {
  return audit.flatMap((entry, auditIndex) => {
    if (!entry.ok || entry.name !== "read_file") return [];
    const preview = structuredToolResultModelPreview({ toolName: entry.name, output: entry.result });
    if (!preview) return [];
    const path = safeRelativePath(preview.path);
    if (!path) return [];
    return [{
      path,
      startLine: finitePositiveInteger(preview.start_line) ?? undefined,
      endLine: finitePositiveInteger(preview.end_line) ?? undefined,
      truncated: preview.truncated === true,
      content: boundedSourceContent(preview.content),
      auditIndex,
    }];
  }).slice(-MAX_VERIFIED_READS);
}

function uniqueCandidates(candidates: SourceCandidate[]): SourceCandidate[] {
  const unique = new Map<string, SourceCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.path}:${candidate.line ?? "file"}`;
    if (!unique.has(key)) unique.set(key, candidate);
    if (unique.size >= MAX_CANDIDATES) break;
  }
  return [...unique.values()];
}

function interleavedCandidates(searches: SearchFrontier[]): SourceCandidate[] {
  const candidates: SourceCandidate[] = [];
  for (let index = 0; index < MAX_CANDIDATES_PER_SEARCH; index += 1) {
    for (const search of searches) {
      const candidate = search.candidates[index];
      if (candidate) candidates.push(candidate);
    }
  }
  return uniqueCandidates(candidates);
}

function boundedSourceContent(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  return trimmed.length <= MAX_READ_CONTENT_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_READ_CONTENT_CHARS)}...`;
}

function boundedPublicText(value: unknown, maxChars: number): string | undefined {
  const safe = safeOptionalPublicText(value);
  if (!safe) return undefined;
  return safe.slice(0, maxChars);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finitePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function compactUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
