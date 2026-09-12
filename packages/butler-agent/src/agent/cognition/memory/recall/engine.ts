import { memorySourceHandle, rawMemorySourceId } from "./source-ref.ts";
import { resultInterpretations } from "./interpretations.ts";
import { readClaim } from "../projection/claim-store.ts";
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { sanitizeProjectMemoryId } from "../project-memory.ts";
import type {
  RetrievalEvidenceRequirement,
  RetrievalPlan,
  RetrievalStrategy,
} from "../retrieval-planning.ts";
import { cognitionMemoryRoot } from "../../paths.ts";
import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";
import {
  filterCurrentGenerationVectorMatches,
  type GenerationVectorMatches,
  searchGenerationVectors,
  searchVectorEpisodes,
  type VectorEpisodeBackend,
} from "./vector.ts";
import {
  resolveMemoryGeneration,
  type MemoryGenerationHandle,
} from "../projection/generation.ts";
import {
  identityMembersForTarget,
  resolveIdentityAt,
} from "../projection/identity.ts";
import {
  canonicalConversationProjectionInventory,
  hydrateSources,
} from "../projection/source.ts";
import { openProjectionDb, sourceRows } from "../projection/store.ts";
import { graphemeCount } from "../projection/unicode.ts";
import {
  claimEligibility,
  scopeArgs,
  scopeSql,
  selectEpisodeRelationshipRows,
  selectSemanticSeeds,
  selectRawSourceCandidates,
  selectTemporalSeeds,
} from "./candidates.ts";
import { expandGraph } from "./graph.ts";
import { rawSourceExcerpt } from "./source-excerpt.ts";
import {
  diversifyBySession,
  fuseEpisodeCandidates,
  rankEpisodes,
} from "./ranking.ts";
import type {
  RecallMemoryInput,
  RecallMemoryResult,
  RecallMention,
} from "./contracts.ts";
import { excludedMemorySourceIds } from "../../feedback/buffer.ts";

export type RecallSource =
  | "hot-cache"
  | "vector"
  | "graph"
  | "explicit"
  | "hybrid"
  | "project-memory"
  | "task-memory";

export interface RecallNode {
  id: string;
  type: string;
  name: string;
  degree?: number;
}

export interface RecallEdge {
  sourceId: string;
  targetId: string;
  relType: string;
  weight?: number;
}

export interface RecallCandidate {
  id: string;
  summary: string;
  text: string;
  source: RecallSource;
  originalSource?:
    | "hot-cache"
    | "project-memory"
    | "task-memory"
    | "rules"
    | "graph";
  provenance: string[];
  relatedNodes?: string[];
  timestamp?: number;
  frequency?: number;
  explicitSalience?: number;
  vectorSimilarity?: number;
  contextualScore?: number;
  supersededBy?: string;
  contradicts?: string[];
}

export interface RecallContextInput {
  recentContext?: string;
  activeTaskSummary?: string;
  projectState?: string;
  recentArtifacts?: string[];
  recentActions?: string[];
  projectId?: string;
  sessionId?: string;
}

export interface RecallCorpus {
  hotCacheHints?: string[];
  nodes: RecallNode[];
  edges: RecallEdge[];
  candidates: RecallCandidate[];
}

export interface RecallScoreBreakdown {
  semantic_similarity: number;
  lexical_match: number;
  contextual_match: number;
  graph_activation: number;
  recency_score: number;
  frequency_score: number;
  explicit_salience: number;
  evidence_confidence: number;
  decision_preference_boost: number;
  hub_penalty: number;
  conflict_penalty: number;
  stale_superseded_penalty: number;
  total: number;
}

type V2RecallResultItem = RecallMemoryResult["results"][number];
type RecallResultEvidenceFacts = {
  projectIds: Set<string>;
  recentSourceHit: boolean;
  explicitRuleSourceHit: boolean;
};
const recallResultEvidenceFacts = Symbol("recallResultEvidenceFacts");

export function readRecallResultEvidenceFacts(
  item: V2RecallResultItem,
): RecallResultEvidenceFacts | null {
  return (item as V2RecallResultItem & {
    [recallResultEvidenceFacts]?: RecallResultEvidenceFacts;
  })[recallResultEvidenceFacts] ?? null;
}

export interface RecallItem {
  summary: string;
  confidence: number;
  source: RecallSource;
  originalSource?: RecallCandidate["originalSource"];
  provenance: string[];
  related_nodes: string[];
  score_breakdown: RecallScoreBreakdown;
}

export interface AssociativeRecallResult {
  cue: string;
  seeds: string[];
  items: RecallItem[];
  abstained: boolean;
  diagnostics: string[];
}

export interface RecallEvidencePolicy {
  evidenceRequired?: RetrievalEvidenceRequirement[];
  retrievalPlan?: Pick<RetrievalPlan, "strategies" | "evidence_required">;
  strategies?: RetrievalStrategy[];
  minEvidenceConfidence?: number;
  requireSpecificMemory?: boolean;
  tieMargin?: number;
  excludeContradicted?: boolean;
}

export function recallRankingPolicyFromPlan(
  plan: Pick<RetrievalPlan, "strategies" | "evidence_required">,
): RecallEvidencePolicy {
  return {
    retrievalPlan: plan,
    evidenceRequired: plan.evidence_required,
  };
}

export interface RecallEvidenceVerification {
  verified: boolean;
  items: RecallItem[];
  diagnostics: string[];
  nextAction: "answer" | "try_alternate_retrieval" | "ask_user";
}

const DEFAULT_LIMIT = 5;
const FILE_CANDIDATE_SUMMARY_CHARS = 420;
const HOT_CACHE_HINT_CHARS = 240;
const RECALL_SEED_MIN_CHARS = 2;
const RECALL_SEED_MAX_TERMS = 24;
const NON_ASCII_LEXICAL_SHINGLE_MIN_CHARS = 2;
const NON_ASCII_LEXICAL_SHINGLE_MAX_CHARS = 3;
const BM25_IDF_SMOOTHING = 0.5;
// BM25 defaults match Apache Lucene BM25Similarity, which cites Robertson et al.,
// "Okapi at TREC-3"; k1 controls term-frequency saturation, b length normalization.
const BM25_TERM_FREQUENCY_SATURATION_K1 = 1.2;
const BM25_DOCUMENT_LENGTH_NORMALIZATION_B = 0.75;
const LEXICAL_SEED_COVERAGE_EXPONENT = 4;
const UNKNOWN_TIMESTAMP_RECENCY_SCORE = 0.15;
const RECENCY_DECAY_WINDOW_DAYS = 30;
const FREQUENCY_NORMALIZATION_REFERENCE_COUNT = 8;
const GRAPH_ACTIVATION_HOPS = 2;
const GRAPH_EDGE_WEIGHT_CAP = 2;
// Tuned policy constants, not learned weights: they only shape graph spreading
// after lexical/vector/contextual evidence has selected a candidate path.
const GRAPH_FORWARD_SPREAD_FACTOR = 0.58;
const GRAPH_REVERSE_SPREAD_FACTOR = 0.45;
const HUB_PENALTY_FREE_DEGREE = 8;
const HUB_PENALTY_FULL_SCALE = 40;
const CONFLICTING_MEMORY_PENALTY = 0.4;
const SUPERSEDED_MEMORY_PENALTY = 0.7;
// Coverage-normalized BM25 scores are intentionally conservative; below this
// floor the match is usually incidental single-token overlap in regression
// fixtures rather than usable recall evidence.
const DEFAULT_MIN_RECALL_SCORE = 0.01;
// The default floor remains the normal confidence gate. This lower floor is
// only used when no candidate reaches that gate and the top candidate clearly
// separates from nearby alternatives, which preserves weak-but-specific recall
// without turning generic overlap into an answer.
const LOW_CONFIDENCE_RECALL_FLOOR = 0.0001;
const LOW_CONFIDENCE_DOMINANCE_RATIO = 2;
// A single lexical seed such as "last time" is an underspecified recall cue.
// Low-confidence lexical-only recall needs at least two independent seed
// groups before the dominance gate is allowed to rescue it.
const LOW_CONFIDENCE_MIN_LEXICAL_SEED_MATCHES = 2;
// LanceDB nearest-neighbor scores can form tight clusters. Within that
// neighborhood, lexical/query corroboration is a tie-breaker and an ambiguity
// guard; outside it, the vector score remains the primary semantic evidence.
const VECTOR_SEMANTIC_NEIGHBORHOOD_MARGIN = 0.03;
const VECTOR_AMBIGUITY_SCAN_MARGIN = 0.05;
const VECTOR_AMBIGUOUS_NEIGHBORHOOD_MIN_CORROBORATION = 0.025;
const VECTOR_QUERY_MIN_CORROBORATING_SEED_MATCHES = 2;
const DEFAULT_RECALL_CACHE_TTL_MS = 30_000;
const V2_RECALL_DEADLINE_MS = 5_000;
const V2_RECALL_SOURCE_RESERVE_MS = 2_000;
const V2_RECALL_GRAPH_RESERVE_MS = 1_500;
const V2_RECALL_ENVELOPE_BYTES = 24 * 1024;
const V2_RECALL_COMPACT_EXCERPT_GRAPHEMES = 120;
const V2_RECALL_CURSOR_TTL_MS = 5 * 60_000;
const V2_RECALL_CURSOR_MAX_ENTRIES = 32;
type V2RecallCandidateMetadata = Pick<
  RecallMemoryResult["results"][number],
  | "episode_ref"
  | "revision"
  | "channels"
  | "matched_node_ref"
  | "association_path"
  | "qualifications"
>;
type V2RecallInventory = {
  createdAt: number;
  argumentHash: string;
  generationId: string;
  graphRevision: string;
  asOf: string;
  candidates: V2RecallCandidateMetadata[];
  status?: RecallMemoryResult["status"];
  coverage?: RecallMemoryResult["coverage"];
  diagnostics?: string[];
};
type V2RecallInventoryCache = Map<string, V2RecallInventory>;

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function listFiles(
  dir: string,
  predicate: (name: string) => boolean,
): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(predicate)
    .map((name) => join(dir, name));
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit
    ? `${normalized.slice(0, limit)}...`
    : normalized;
}

export function extractRecallSeeds(cue: string): string[] {
  return cue
    .toLowerCase()
    .split(/[^\p{L}\p{N}._-]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= RECALL_SEED_MIN_CHARS)
    .filter((part, index, values) => values.indexOf(part) === index)
    .slice(0, RECALL_SEED_MAX_TERMS);
}

function lexicalTokens(text: string): string[] {
  const tokens = text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}._-]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= RECALL_SEED_MIN_CHARS);
  return [...tokens, ...tokens.flatMap(nonAsciiLexicalShingles)]
    .filter((part, index, values) => values.indexOf(part) === index);
}

function nonAsciiLexicalShingles(token: string): string[] {
  if (!hasNonAscii(token) || !/\p{L}/u.test(token)) return [];
  const chars = [...token];
  const shingles: string[] = [];
  for (
    let size = NON_ASCII_LEXICAL_SHINGLE_MIN_CHARS;
    size <= NON_ASCII_LEXICAL_SHINGLE_MAX_CHARS;
    size += 1
  ) {
    if (chars.length < size) continue;
    for (let index = 0; index <= chars.length - size; index += 1) {
      shingles.push(chars.slice(index, index + size).join(""));
    }
  }
  return shingles;
}

function hasNonAscii(value: string): boolean {
  return [...value].some((char) => {
    const codePoint = char.codePointAt(0);
    return codePoint !== undefined && codePoint > 0x7f;
  });
}

function frequencyMap(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
  return map;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

interface LexicalStats {
  queryTerms: string[];
  querySeedTerms: string[][];
  documentFrequency: Map<string, number>;
  averageDocumentLength: number;
  documentCount: number;
}

interface LexicalScoreResult {
  score: number;
  matchedSeedCount: number;
  seedCoverage: number;
}

function buildLexicalStats(
  candidates: RecallCandidate[],
  seeds: string[],
): LexicalStats {
  const querySeedTerms = seeds
    .map((seed) => lexicalTokens(seed))
    .filter((terms) => terms.length > 0);
  const queryTerms = [...new Set(querySeedTerms.flat())];
  const documentFrequency = new Map<string, number>();
  let totalDocumentLength = 0;
  for (const candidate of candidates) {
    const documentTokens = lexicalTokens(
      `${candidate.summary}\n${candidate.text}`,
    );
    const uniqueDocumentTokens = new Set(documentTokens);
    totalDocumentLength += documentTokens.length;
    for (const term of queryTerms) {
      if (uniqueDocumentTokens.has(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }
  return {
    queryTerms,
    querySeedTerms,
    documentFrequency,
    averageDocumentLength: candidates.length > 0
      ? totalDocumentLength / candidates.length
      : 0,
    documentCount: candidates.length,
  };
}

function idf(term: string, stats: LexicalStats): number {
  const frequency = stats.documentFrequency.get(term) ?? 0;
  if (frequency === 0 || stats.documentCount === 0) return 0;
  return Math.log(
    1 +
      (stats.documentCount - frequency + BM25_IDF_SMOOTHING) /
        (frequency + BM25_IDF_SMOOTHING),
  );
}

function lexicalScore(
  candidate: RecallCandidate,
  stats: LexicalStats,
): LexicalScoreResult {
  if (stats.queryTerms.length === 0 || stats.documentCount === 0) {
    return { score: 0, matchedSeedCount: 0, seedCoverage: 0 };
  }
  const tokens = lexicalTokens(`${candidate.summary}\n${candidate.text}`);
  if (tokens.length === 0) {
    return { score: 0, matchedSeedCount: 0, seedCoverage: 0 };
  }
  const frequencies = frequencyMap(tokens);
  const averageLength = stats.averageDocumentLength > 0
    ? stats.averageDocumentLength
    : tokens.length;
  let score = 0;
  let availableQueryWeight = 0;
  for (const term of stats.queryTerms) {
    const termIdf = idf(term, stats);
    if (termIdf <= 0) continue;
    availableQueryWeight += termIdf;
    const termFrequency = frequencies.get(term) ?? 0;
    if (termFrequency === 0) continue;
    const lengthNormalization = BM25_TERM_FREQUENCY_SATURATION_K1 *
      (1 - BM25_DOCUMENT_LENGTH_NORMALIZATION_B +
        BM25_DOCUMENT_LENGTH_NORMALIZATION_B * (tokens.length / averageLength));
    score += termIdf *
      ((termFrequency * (BM25_TERM_FREQUENCY_SATURATION_K1 + 1)) /
        (termFrequency + lengthNormalization));
  }
  if (availableQueryWeight <= 0) {
    return { score: 0, matchedSeedCount: 0, seedCoverage: 0 };
  }
  const matchedQueryTermSet = new Set<string>();
  for (const term of stats.queryTerms) {
    if ((frequencies.get(term) ?? 0) > 0) matchedQueryTermSet.add(term);
  }
  const matchedSeedCount =
    stats.querySeedTerms.filter((terms) =>
      terms.some((term) => matchedQueryTermSet.has(term)),
    ).length;
  const seedCoverage = stats.querySeedTerms.length > 0
    ? matchedSeedCount / stats.querySeedTerms.length
    : 0;
  return {
    score: clamp01(
      (score / availableQueryWeight) *
        (seedCoverage ** LEXICAL_SEED_COVERAGE_EXPONENT),
    ),
    matchedSeedCount,
    seedCoverage,
  };
}

function semanticScore(candidate: RecallCandidate): number {
  if (
    candidate.source !== "vector" ||
    typeof candidate.vectorSimilarity !== "number"
  ) return 0;
  return clamp01(candidate.vectorSimilarity);
}

function explicitEvidenceScore(
  candidate: RecallCandidate,
  anchorScore: number,
): number {
  const salience = candidate.explicitSalience ??
    (candidate.source === "explicit" ? 1 : 0);
  if (salience <= 0 || anchorScore <= 0) return 0;
  return clamp01(salience * anchorScore);
}

interface ContextualRecallEvidence {
  terms: Set<string>;
  relatedNodeIds: Set<string>;
  provenanceNeedles: string[];
}

function buildContextualRecallEvidence(
  context: RecallContextInput | undefined,
  corpus: RecallCorpus,
): ContextualRecallEvidence | null {
  if (!context) return null;
  const contextText = [
    context.recentContext,
    context.activeTaskSummary,
    context.projectState,
    ...(context.recentArtifacts ?? []),
    ...(context.recentActions ?? []),
  ].filter((item): item is string => Boolean(item?.trim())).join("\n");
  const terms = new Set(lexicalTokens(contextText));
  const relatedNodeIds = new Set<string>();
  for (const node of corpus.nodes) {
    const nodeTerms = lexicalTokens(node.name);
    if (nodeTerms.length > 0 && nodeTerms.some((term) => terms.has(term))) {
      relatedNodeIds.add(node.id);
    }
  }
  const provenanceNeedles = [
    context.sessionId,
    ...(context.recentArtifacts ?? []),
  ].flatMap((value) => lexicalTokens(value ?? "")).filter((
    value,
    index,
    values,
  ) => values.indexOf(value) === index);
  if (
    terms.size === 0 && relatedNodeIds.size === 0 &&
    provenanceNeedles.length === 0
  ) return null;
  return {
    terms,
    relatedNodeIds,
    provenanceNeedles,
  };
}

function binaryCosine(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return clamp01(overlap / Math.sqrt(left.size * right.size));
}

function contextualScore(
  candidate: RecallCandidate,
  evidence: ContextualRecallEvidence | null,
): number {
  const explicit = clamp01(candidate.contextualScore ?? 0);
  if (!evidence) return explicit;
  const candidateTerms = new Set(
    lexicalTokens(`${candidate.summary}\n${candidate.text}`),
  );
  const lexicalContinuity = binaryCosine(evidence.terms, candidateTerms);
  const relatedNodes = candidate.relatedNodes ?? [];
  const graphContinuity = relatedNodes.length === 0
    ? 0
    : relatedNodes.filter((node) => evidence.relatedNodeIds.has(node)).length /
      relatedNodes.length;
  const provenanceContinuity =
    evidence.provenanceNeedles.some((needle) =>
        candidate.provenance.some((provenance) =>
          lexicalTokens(provenance).includes(needle),
        ),
      )
      ? 1
      : 0;
  return Math.max(
    explicit,
    lexicalContinuity,
    graphContinuity,
    provenanceContinuity,
  );
}

function recencyScore(timestamp: number | undefined, now: number): number {
  if (!timestamp) return UNKNOWN_TIMESTAMP_RECENCY_SCORE;
  const ageMs = Math.max(0, now - timestamp * 1000);
  const recencyWindowMs = RECENCY_DECAY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(0, 1 - ageMs / recencyWindowMs);
}

function frequencyScore(value: number | undefined): number {
  return Math.min(
    1,
    Math.log1p(value ?? 0) /
      Math.log1p(FREQUENCY_NORMALIZATION_REFERENCE_COUNT),
  );
}

function buildDegreeMap(corpus: RecallCorpus): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of corpus.edges) {
    degree.set(edge.sourceId, (degree.get(edge.sourceId) ?? 0) + 1);
    degree.set(edge.targetId, (degree.get(edge.targetId) ?? 0) + 1);
  }
  for (const node of corpus.nodes) {
    if (node.degree !== undefined) degree.set(node.id, node.degree);
  }
  return degree;
}

function activateGraph(
  corpus: RecallCorpus,
  seeds: string[],
): Map<string, number> {
  const activation = new Map<string, number>();
  const degree = buildDegreeMap(corpus);
  for (const node of corpus.nodes) {
    const name = node.name.toLowerCase();
    const matched = seeds.some((seed) =>
      name.includes(seed) || seed.includes(name),
    );
    if (matched) activation.set(node.id, 1);
  }

  for (let hop = 0; hop < GRAPH_ACTIVATION_HOPS; hop += 1) {
    const next = new Map(activation);
    for (const edge of corpus.edges) {
      const weight = edge.weight ?? 1;
      const cappedWeight = Math.min(GRAPH_EDGE_WEIGHT_CAP, weight);
      const spread = GRAPH_FORWARD_SPREAD_FACTOR * cappedWeight /
        (1 + (degree.get(edge.sourceId) ?? 0));
      const reverseSpread = GRAPH_REVERSE_SPREAD_FACTOR * cappedWeight /
        (1 + (degree.get(edge.targetId) ?? 0));
      const sourceActivation = activation.get(edge.sourceId) ?? 0;
      const targetActivation = activation.get(edge.targetId) ?? 0;
      if (sourceActivation > 0) {
        next.set(
          edge.targetId,
          Math.max(next.get(edge.targetId) ?? 0, sourceActivation * spread),
        );
      }
      if (targetActivation > 0) {
        next.set(
          edge.sourceId,
          Math.max(
            next.get(edge.sourceId) ?? 0,
            targetActivation * reverseSpread,
          ),
        );
      }
    }
    activation.clear();
    for (const [key, value] of next) activation.set(key, value);
  }
  return activation;
}

function candidateGraphActivation(
  candidate: RecallCandidate,
  activation: Map<string, number>,
): number {
  const nodes = candidate.relatedNodes ?? [];
  if (nodes.length === 0) return 0;
  return Math.max(...nodes.map((node) => activation.get(node) ?? 0), 0);
}

function candidateHubPenalty(
  candidate: RecallCandidate,
  degree: Map<string, number>,
): number {
  const nodes = candidate.relatedNodes ?? [];
  if (nodes.length === 0) return 0;
  return Math.max(
    ...nodes.map((node) =>
      Math.min(
        1,
        Math.max(
          0,
          ((degree.get(node) ?? 0) - HUB_PENALTY_FREE_DEGREE) /
            HUB_PENALTY_FULL_SCALE,
        ),
      ),
    ),
    0,
  );
}

function candidateConflictPenalty(
  candidate: RecallCandidate,
  activeCandidateIds: Set<string>,
): number {
  return candidate.contradicts?.some((id) => activeCandidateIds.has(id))
    ? CONFLICTING_MEMORY_PENALTY
    : 0;
}

function candidateBoost(candidate: RecallCandidate): number {
  void candidate;
  return 0;
}

interface RecallRankingSignals {
  semantic: number;
  lexical: number;
  contextual: number;
  graph: number;
  recency: number;
  frequency: number;
  explicit: number;
  boost: number;
  hub: number;
  conflict: number;
  superseded: number;
}

interface ScoredRecallCandidate {
  candidate: RecallCandidate;
  hasEvidence: boolean;
  breakdown: RecallScoreBreakdown;
  lexicalMatchedSeedCount: number;
  lexicalSeedCoverage: number;
}

interface ScoreGateSelection {
  items: ScoredRecallCandidate[];
  diagnostic: string;
}

interface ActiveRecallPolicy {
  planned: boolean;
  strategies: RetrievalStrategy[];
  evidenceRequired: RetrievalEvidenceRequirement[];
}

function activeRecallPolicy(
  policy: RecallEvidencePolicy | undefined,
): ActiveRecallPolicy {
  const strategies = uniqueStrings([
    ...(policy?.retrievalPlan?.strategies ?? []),
    ...(policy?.strategies ?? []),
  ]) as RetrievalStrategy[];
  const evidenceRequired = uniqueStrings([
    ...(policy?.retrievalPlan?.evidence_required ?? []),
    ...(policy?.evidenceRequired ?? []),
  ]) as RetrievalEvidenceRequirement[];
  return {
    planned: strategies.length > 0 || evidenceRequired.length > 0,
    strategies,
    evidenceRequired,
  };
}

function nonExactEvidenceRequirements(
  policy: ActiveRecallPolicy,
): RetrievalEvidenceRequirement[] {
  return policy.evidenceRequired.filter((requirement) =>
    requirement !== "exact_quote",
  );
}

function uniqueStrings<T extends string>(values: T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function hasVectorProvenance(candidate: RecallCandidate): boolean {
  return candidate.source === "vector" &&
    candidate.provenance.some((entry) => entry.startsWith("vector:"));
}

function hasProjectMemoryProvenance(candidate: RecallCandidate): boolean {
  return candidate.source === "project-memory" ||
    candidate.originalSource === "project-memory";
}

function hasTaskContinuityProvenance(candidate: RecallCandidate): boolean {
  return candidate.provenance.some((entry) =>
    entry.startsWith("task:") || entry.includes(":task:"),
  );
}

function hasRecentTurnProvenance(candidate: RecallCandidate): boolean {
  return candidate.source === "hot-cache" ||
    candidate.provenance.some((entry) =>
      entry.startsWith("session:") || entry.startsWith("turn:"),
    );
}

function evidenceRequirementScore(
  requirement: RetrievalEvidenceRequirement,
  candidate: RecallCandidate,
  signals: RecallRankingSignals,
): number {
  if (requirement === "exact_quote") return 0;
  if (requirement === "vector_episode_hit") {
    return hasVectorProvenance(candidate) ? signals.semantic : 0;
  }
  if (requirement === "project_memory_hit") {
    return hasProjectMemoryProvenance(candidate)
      ? Math.max(
        signals.lexical,
        signals.contextual,
        signals.graph,
        signals.explicit,
      )
      : 0;
  }
  if (requirement === "graph_relation_hit") {
    return candidate.relatedNodes?.length ? signals.graph : 0;
  }
  if (requirement === "explicit_rule_hit") {
    return candidate.source === "explicit" ||
        candidate.originalSource === "rules"
      ? signals.explicit
      : 0;
  }
  if (requirement === "task_continuity") {
    if (signals.contextual > 0) return signals.contextual;
    return hasTaskContinuityProvenance(candidate)
      ? Math.max(signals.lexical, signals.graph, signals.explicit)
      : 0;
  }
  if (requirement === "recent_turn_hit") {
    return hasRecentTurnProvenance(candidate)
      ? Math.max(signals.contextual, signals.lexical)
      : 0;
  }
  return 0;
}

function strategyEvidenceScore(
  strategy: RetrievalStrategy,
  candidate: RecallCandidate,
  signals: RecallRankingSignals,
): number {
  if (strategy === "search_vector_episode") {
    return evidenceRequirementScore("vector_episode_hit", candidate, signals);
  }
  if (strategy === "search_lexical_memory") return signals.lexical;
  if (strategy === "read_graph_memory") {
    return evidenceRequirementScore("graph_relation_hit", candidate, signals);
  }
  if (strategy === "read_explicit_memory") {
    return evidenceRequirementScore("explicit_rule_hit", candidate, signals);
  }
  if (strategy === "read_task_state") {
    return evidenceRequirementScore("task_continuity", candidate, signals);
  }
  if (strategy === "read_recent_context") {
    return Math.max(
      signals.contextual,
      evidenceRequirementScore("recent_turn_hit", candidate, signals),
    );
  }
  if (strategy === "query_exact_transcript") return 0;
  return 0;
}

function requirementForStrategy(
  strategy: RetrievalStrategy,
): RetrievalEvidenceRequirement | null {
  if (strategy === "search_vector_episode") return "vector_episode_hit";
  if (strategy === "search_lexical_memory") return "project_memory_hit";
  if (strategy === "read_graph_memory") return "graph_relation_hit";
  if (strategy === "read_explicit_memory") return "explicit_rule_hit";
  if (strategy === "read_task_state") return "task_continuity";
  if (strategy === "read_recent_context") return "recent_turn_hit";
  if (strategy === "query_exact_transcript") return "exact_quote";
  return null;
}

function plannedStrategyEvidenceScore(
  strategy: RetrievalStrategy,
  candidate: RecallCandidate,
  signals: RecallRankingSignals,
  policy: ActiveRecallPolicy,
): number {
  const mappedRequirement = requirementForStrategy(strategy);
  if (
    mappedRequirement &&
    policy.evidenceRequired.includes(mappedRequirement) &&
    evidenceRequirementScore(mappedRequirement, candidate, signals) <= 0
  ) {
    return 0;
  }
  return strategyEvidenceScore(strategy, candidate, signals);
}

function evidenceConfidence(
  candidate: RecallCandidate,
  signals: RecallRankingSignals,
  policy: ActiveRecallPolicy,
): number {
  if (!policy.planned) {
    return fallbackEvidenceScore(signals);
  }
  const plannedScores = policy.strategies.map((strategy) =>
    plannedStrategyEvidenceScore(strategy, candidate, signals, policy),
  );
  const requiredScores = policy.evidenceRequired
    .filter((requirement) => requirement !== "exact_quote")
    .map((requirement) =>
      evidenceRequirementScore(requirement, candidate, signals),
    );
  return Math.max(...plannedScores, ...requiredScores, 0);
}

function recallPenalty(signals: RecallRankingSignals): number {
  return Math.max(signals.hub, signals.conflict, signals.superseded);
}

function fallbackEvidenceScore(signals: RecallRankingSignals): number {
  // Graph activation is a routing clue in fallback recall, not standalone
  // evidence that the candidate text answers the cue. Planned graph retrieval
  // can still request graph_relation_hit explicitly.
  return Math.max(
    signals.semantic,
    signals.lexical,
    signals.contextual,
    signals.explicit,
  );
}

function fallbackRecallScore(signals: RecallRankingSignals): number {
  if (signals.superseded > 0) return 0;
  const evidence = fallbackEvidenceScore(signals);
  if (evidence <= 0) return 0;
  return clamp01(evidence + signals.boost - recallPenalty(signals));
}

function plannedRecallScore(
  candidate: RecallCandidate,
  signals: RecallRankingSignals,
  policy: ActiveRecallPolicy,
): number {
  if (!policy.planned) return fallbackRecallScore(signals);
  const strategyScores = policy.strategies.map((strategy) =>
    plannedStrategyEvidenceScore(strategy, candidate, signals, policy),
  );
  const requiredScores = policy.evidenceRequired.map((requirement) =>
    evidenceRequirementScore(requirement, candidate, signals),
  );
  if (
    requiredScores.length > 0 && requiredScores.every((score) => score <= 0)
  ) return 0;
  const bestEvidence = Math.max(...strategyScores, ...requiredScores, 0);
  if (bestEvidence <= 0) return 0;
  return clamp01(bestEvidence + signals.boost - recallPenalty(signals));
}

function plannedStrategyIndex(
  candidate: RecallCandidate,
  breakdown: RecallScoreBreakdown,
  policy: ActiveRecallPolicy,
): number {
  if (!policy.planned) return Number.MAX_SAFE_INTEGER;
  const signals: RecallRankingSignals = {
    semantic: breakdown.semantic_similarity,
    lexical: breakdown.lexical_match,
    contextual: breakdown.contextual_match,
    graph: breakdown.graph_activation,
    recency: breakdown.recency_score,
    frequency: breakdown.frequency_score,
    explicit: breakdown.explicit_salience,
    boost: breakdown.decision_preference_boost,
    hub: breakdown.hub_penalty,
    conflict: breakdown.conflict_penalty,
    superseded: breakdown.stale_superseded_penalty,
  };
  const index = policy.strategies.findIndex((strategy) =>
    plannedStrategyEvidenceScore(strategy, candidate, signals, policy) > 0,
  );
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function compareScoredRecall(
  left: { candidate: RecallCandidate; breakdown: RecallScoreBreakdown },
  right: { candidate: RecallCandidate; breakdown: RecallScoreBreakdown },
  policy: ActiveRecallPolicy,
): number {
  if (policy.planned) {
    const leftIndex = plannedStrategyIndex(
      left.candidate,
      left.breakdown,
      policy,
    );
    const rightIndex = plannedStrategyIndex(
      right.candidate,
      right.breakdown,
      policy,
    );
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  }
  if (
    isVectorSemanticCandidate(left) &&
    isVectorSemanticCandidate(right) &&
    Math.abs(
        left.breakdown.semantic_similarity -
          right.breakdown.semantic_similarity,
      ) <=
      VECTOR_SEMANTIC_NEIGHBORHOOD_MARGIN
  ) {
    const corroborationDelta = vectorCorroboration(right.breakdown) -
      vectorCorroboration(left.breakdown);
    if (corroborationDelta !== 0) return corroborationDelta;
  }
  return right.breakdown.total - left.breakdown.total;
}

function isVectorSemanticCandidate(
  item: { candidate: RecallCandidate; breakdown: RecallScoreBreakdown },
): boolean {
  return item.candidate.source === "vector" &&
    item.breakdown.semantic_similarity > 0;
}

function vectorCorroboration(breakdown: RecallScoreBreakdown): number {
  return Math.max(
    breakdown.lexical_match,
    breakdown.contextual_match,
    breakdown.graph_activation,
    breakdown.explicit_salience,
  );
}

function hasAmbiguousVectorNeighborhood(
  items: ScoredRecallCandidate[],
): boolean {
  const first = items[0];
  if (!first || !isVectorSemanticCandidate(first)) return false;
  const second = items.find((item) =>
    item !== first && isVectorSemanticCandidate(item),
  );
  if (!second) return false;
  return first.breakdown.semantic_similarity -
      second.breakdown.semantic_similarity <=
    VECTOR_AMBIGUITY_SCAN_MARGIN;
}

function lowConfidenceCandidateDominates(
  first: ScoredRecallCandidate | undefined,
  second: ScoredRecallCandidate | undefined,
  policy: ActiveRecallPolicy,
): boolean {
  if (!first) return false;
  const firstScore = first.breakdown.total;
  if (firstScore < LOW_CONFIDENCE_RECALL_FLOOR) return false;
  if (policy.planned) return true;
  const lexicalOnly = first.breakdown.lexical_match > 0 &&
    first.breakdown.semantic_similarity <= 0 &&
    first.breakdown.contextual_match <= 0 &&
    first.breakdown.explicit_salience <= 0;
  if (
    lexicalOnly &&
    first.lexicalMatchedSeedCount < LOW_CONFIDENCE_MIN_LEXICAL_SEED_MATCHES
  ) {
    return false;
  }
  const secondScore = second?.breakdown.total ?? 0;
  if (secondScore <= 0) return true;
  return firstScore / secondScore >= LOW_CONFIDENCE_DOMINANCE_RATIO;
}

function selectScoredRecallCandidates(input: {
  scored: ScoredRecallCandidate[];
  minScore: number;
  limit: number;
  policy: ActiveRecallPolicy;
}): ScoreGateSelection {
  const standardItems = input.scored.filter((item) =>
    item.breakdown.total >= input.minScore,
  );
  if (standardItems.length > 0) {
    const firstStandard = standardItems[0];
    if (
      firstStandard &&
      hasAmbiguousVectorNeighborhood(standardItems) &&
      vectorCorroboration(firstStandard.breakdown) <
        VECTOR_AMBIGUOUS_NEIGHBORHOOD_MIN_CORROBORATION
    ) {
      const corroboratedItems = standardItems.filter((item) =>
        !isVectorSemanticCandidate(item) ||
        vectorCorroboration(item.breakdown) >=
          VECTOR_AMBIGUOUS_NEIGHBORHOOD_MIN_CORROBORATION,
      );
      if (corroboratedItems.length > 0) {
        return {
          items: corroboratedItems.slice(0, input.limit),
          diagnostic: "score_gate=corroborated-vector-neighborhood",
        };
      }
      return {
        items: [],
        diagnostic: "score_gate=ambiguous-vector-neighborhood",
      };
    }
    return {
      items: standardItems.slice(0, input.limit),
      diagnostic: "score_gate=standard",
    };
  }

  const lowConfidenceItems = input.scored.filter((item) =>
    item.breakdown.total >= LOW_CONFIDENCE_RECALL_FLOOR &&
    item.breakdown.total < input.minScore,
  );
  if (lowConfidenceItems.length === 0) {
    return {
      items: [],
      diagnostic: "score_gate=below-floor",
    };
  }
  if (
    !lowConfidenceCandidateDominates(
      lowConfidenceItems[0],
      lowConfidenceItems[1],
      input.policy,
    )
  ) {
    return {
      items: [],
      diagnostic: "score_gate=ambiguous-low-confidence",
    };
  }
  return {
    items: lowConfidenceItems.slice(0, input.limit),
    diagnostic: "score_gate=dominant-low-confidence",
  };
}

function sourceForCandidate(
  candidate: RecallCandidate,
  semantic: number,
  graph: number,
): RecallSource {
  if (candidate.source === "explicit") return "explicit";
  if (graph > 0 && semantic > 0) return "hybrid";
  if (graph > 0) return "graph";
  return candidate.source;
}

function itemSatisfiesEvidenceRequirement(
  item: RecallItem,
  requirement: RetrievalEvidenceRequirement,
): boolean {
  const breakdown = item.score_breakdown;
  if (requirement === "exact_quote") return false;
  if (requirement === "vector_episode_hit") {
    return breakdown.semantic_similarity > 0 &&
      item.provenance.some((entry) => entry.startsWith("vector:"));
  }
  if (requirement === "project_memory_hit") {
    return (item.source === "project-memory" ||
      item.originalSource === "project-memory") &&
      Math.max(
          breakdown.lexical_match,
          breakdown.contextual_match,
          breakdown.graph_activation,
        ) > 0;
  }
  if (requirement === "graph_relation_hit") {
    return breakdown.graph_activation > 0 && item.related_nodes.length > 0;
  }
  if (requirement === "explicit_rule_hit") {
    return (item.source === "explicit" || item.originalSource === "rules") &&
      breakdown.explicit_salience > 0;
  }
  if (requirement === "recent_turn_hit") {
    return (item.source === "hot-cache" ||
      item.provenance.some((entry) =>
        entry.startsWith("session:") || entry.startsWith("turn:"),
      )) &&
      Math.max(breakdown.contextual_match, breakdown.lexical_match) > 0;
  }
  if (requirement === "task_continuity") {
    if (breakdown.contextual_match > 0) return true;
    return item.provenance.some((entry) =>
      entry.startsWith("task:") || entry.includes(":task:"),
    ) &&
      Math.max(
          breakdown.lexical_match,
          breakdown.graph_activation,
          breakdown.explicit_salience,
        ) > 0;
  }
  return false;
}

function vectorQueryCorroborationScore(
  query: string,
  candidate: RecallCandidate,
): number {
  const querySeedTerms = extractRecallSeeds(query)
    .map((seed) => lexicalTokens(seed))
    .filter((terms) => terms.length > 0);
  const queryTerms = new Set(querySeedTerms.flat());
  const candidateTerms = new Set(
    lexicalTokens(`${candidate.summary}\n${candidate.text}`),
  );
  const matchedSeedCount =
    querySeedTerms.filter((terms) =>
      terms.some((term) => candidateTerms.has(term)),
    ).length;
  if (matchedSeedCount < VECTOR_QUERY_MIN_CORROBORATING_SEED_MATCHES) return 0;
  const seedCoverage = querySeedTerms.length > 0
    ? matchedSeedCount / querySeedTerms.length
    : 0;
  return binaryCosine(queryTerms, candidateTerms) * seedCoverage;
}

function mergeVectorCandidate(
  candidates: Map<string, RecallCandidate>,
  candidate: RecallCandidate,
  query: string,
): void {
  const key = candidate.provenance[0] ?? candidate.id;
  const contextualScore = Math.max(
    candidate.contextualScore ?? 0,
    vectorQueryCorroborationScore(query, candidate),
  );
  const existing = candidates.get(key);
  if (!existing) {
    candidates.set(key, {
      ...candidate,
      contextualScore,
    });
    return;
  }
  candidates.set(key, {
    ...existing,
    contextualScore: Math.max(existing.contextualScore ?? 0, contextualScore),
    vectorSimilarity: Math.max(
      existing.vectorSimilarity ?? 0,
      candidate.vectorSimilarity ?? 0,
    ),
    frequency: Math.max(existing.frequency ?? 0, candidate.frequency ?? 0),
  });
}

export function recallFromCorpus(input: {
  cue: string;
  corpus: RecallCorpus;
  context?: RecallContextInput;
  evidencePolicy?: RecallEvidencePolicy;
  rankingPolicy?: RecallEvidencePolicy;
  limit?: number;
  now?: number;
  minScore?: number;
}): AssociativeRecallResult {
  const cue = input.cue.trim();
  if (!cue) throw new Error("recall cue requires text");
  const seeds = extractRecallSeeds(cue);
  const limit = Math.max(
    1,
    Math.min(10, Math.trunc(input.limit ?? DEFAULT_LIMIT)),
  );
  const now = input.now ?? Date.now();
  const activation = activateGraph(input.corpus, seeds);
  const lexicalStats = buildLexicalStats(input.corpus.candidates, seeds);
  const contextualEvidence = buildContextualRecallEvidence(
    input.context,
    input.corpus,
  );
  const degree = buildDegreeMap(input.corpus);
  const activeCandidateIds = new Set(
    input.corpus.candidates.map((candidate) => candidate.id),
  );
  const effectivePolicy = input.rankingPolicy ?? input.evidencePolicy;
  const recallPolicy = activeRecallPolicy(effectivePolicy);

  const scored: ScoredRecallCandidate[] = input.corpus.candidates
    .map((candidate) => {
      const rawSemantic = semanticScore(candidate);
      const lexicalEvidence = lexicalScore(candidate, lexicalStats);
      const lexical = lexicalEvidence.score;
      const contextual = contextualScore(candidate, contextualEvidence);
      const graph = candidateGraphActivation(candidate, activation);
      const semantic = rawSemantic;
      const explicit = explicitEvidenceScore(
        candidate,
        Math.max(semantic, lexical, contextual),
      );
      const signals: RecallRankingSignals = {
        semantic,
        lexical,
        contextual,
        graph,
        recency: recencyScore(candidate.timestamp, now),
        frequency: frequencyScore(candidate.frequency),
        explicit,
        boost: candidateBoost(candidate),
        hub: candidateHubPenalty(candidate, degree),
        conflict: candidateConflictPenalty(candidate, activeCandidateIds),
        superseded: candidate.supersededBy &&
            activeCandidateIds.has(candidate.supersededBy)
          ? SUPERSEDED_MEMORY_PENALTY
          : 0,
      };
      const evidence = evidenceConfidence(candidate, signals, recallPolicy);
      const total = plannedRecallScore(candidate, signals, recallPolicy);
      const hasEvidence = evidence > 0;
      return {
        candidate,
        hasEvidence,
        lexicalMatchedSeedCount: lexicalEvidence.matchedSeedCount,
        lexicalSeedCoverage: lexicalEvidence.seedCoverage,
        breakdown: {
          semantic_similarity: signals.semantic,
          lexical_match: signals.lexical,
          contextual_match: signals.contextual,
          graph_activation: signals.graph,
          recency_score: signals.recency,
          frequency_score: signals.frequency,
          explicit_salience: signals.explicit,
          evidence_confidence: evidence,
          decision_preference_boost: signals.boost,
          hub_penalty: signals.hub,
          conflict_penalty: signals.conflict,
          stale_superseded_penalty: signals.superseded,
          total,
        },
      };
    })
    .filter((item) => item.hasEvidence)
    .filter((item) => item.breakdown.total > 0)
    .sort((left, right) => compareScoredRecall(left, right, recallPolicy));

  const minScore = input.minScore ?? DEFAULT_MIN_RECALL_SCORE;
  const plannedEvidenceLimit = recallPolicy.planned
    ? Math.max(limit, nonExactEvidenceRequirements(recallPolicy).length)
    : limit;
  const scoreSelection = selectScoredRecallCandidates({
    scored,
    minScore,
    limit: plannedEvidenceLimit,
    policy: recallPolicy,
  });
  const rawItems = scoreSelection.items.map(({ candidate, breakdown }) => ({
    summary: candidate.summary,
    confidence: Math.max(0, Math.min(1, breakdown.total)),
    source: sourceForCandidate(
      candidate,
      breakdown.semantic_similarity,
      breakdown.graph_activation,
    ),
    originalSource: candidate.originalSource,
    provenance: candidate.provenance,
    related_nodes: candidate.relatedNodes ?? [],
    score_breakdown: breakdown,
  }));
  const verification = verifyRecallEvidence({
    items: rawItems,
    policy: effectivePolicy,
  });
  const items = verification.items;

  return {
    cue,
    seeds,
    items,
    abstained: items.length === 0,
    diagnostics: [
      `candidates=${input.corpus.candidates.length}`,
      `activated_nodes=${
        [...activation.values()].filter((value) => value > 0).length
      }`,
      `ranking=${
        recallPolicy.planned ? "planned_policy" : "fallback_evidence"
      }`,
      `ranking_policy=${recallPolicy.planned ? "planned" : "fallback"}`,
      scoreSelection.diagnostic,
      `context_terms=${contextualEvidence?.terms.size ?? 0}`,
      `contextual_candidates=${
        rawItems.filter((item) => item.score_breakdown.contextual_match > 0)
          .length
      }`,
      ...verification.diagnostics,
      items.length === 0 ? "abstained=low-confidence" : "abstained=false",
    ],
  };
}

export function verifyRecallEvidence(input: {
  items: RecallItem[];
  policy?: RecallEvidencePolicy;
}): RecallEvidenceVerification {
  const policy = input.policy ?? {};
  const evidenceRequired = activeRecallPolicy(policy).evidenceRequired;
  const diagnostics: string[] = [];
  if (evidenceRequired.includes("exact_quote")) {
    return {
      verified: false,
      items: [],
      diagnostics: ["evidence=exact_quote_requires_query_memory"],
      nextAction: "try_alternate_retrieval",
    };
  }
  if (input.items.length === 0) {
    const missingRequiredEvidence = evidenceRequired.filter((requirement) =>
      requirement !== "exact_quote",
    );
    for (const requirement of missingRequiredEvidence) {
      diagnostics.push(`evidence_missing=${requirement}`);
    }
    return {
      verified: false,
      items: [],
      diagnostics: diagnostics.length > 0 ? diagnostics : ["evidence=none"],
      nextAction: "try_alternate_retrieval",
    };
  }
  const minEvidence = policy.minEvidenceConfidence ?? 0;
  const usableItems = input.items.filter((item) => {
    const breakdown = item.score_breakdown;
    const hasEnoughEvidence = breakdown.evidence_confidence >= minEvidence;
    const contradicted = policy.excludeContradicted === true &&
      (breakdown.conflict_penalty > 0 ||
        breakdown.stale_superseded_penalty > 0);
    return hasEnoughEvidence && !contradicted;
  });

  if (usableItems.length === 0) {
    return {
      verified: false,
      items: [],
      diagnostics: ["evidence=weak_or_contradicted"],
      nextAction: "try_alternate_retrieval",
    };
  }

  const missingRequiredEvidence = evidenceRequired
    .filter((requirement) => requirement !== "exact_quote")
    .filter((requirement) =>
      !usableItems.some((item) =>
        itemSatisfiesEvidenceRequirement(item, requirement),
      ),
    );
  for (const requirement of missingRequiredEvidence) {
    diagnostics.push(`evidence_missing=${requirement}`);
  }
  if (missingRequiredEvidence.length > 0) {
    return {
      verified: false,
      items: [],
      diagnostics,
      nextAction: "try_alternate_retrieval",
    };
  }

  const nonExactRequiredEvidence = evidenceRequired.filter((requirement) =>
    requirement !== "exact_quote",
  );
  const evidenceScopedItems = nonExactRequiredEvidence.length === 0
    ? usableItems
    : usableItems.filter((item) =>
      nonExactRequiredEvidence.some((requirement) =>
        itemSatisfiesEvidenceRequirement(item, requirement),
      ),
    );

  if (policy.requireSpecificMemory && evidenceScopedItems.length > 1) {
    const [first, second] = evidenceScopedItems;
    const margin = Math.max(0, policy.tieMargin ?? 0);
    if (
      first &&
      second &&
      first.confidence - second.confidence <= margin
    ) {
      return {
        verified: false,
        items: [],
        diagnostics: ["evidence=ambiguous_tie"],
        nextAction: "try_alternate_retrieval",
      };
    }
  }

  diagnostics.push("evidence=verified");
  return {
    verified: true,
    items: evidenceScopedItems,
    diagnostics,
    nextAction: "answer",
  };
}

function numericDiagnostic(diagnostics: string[], key: string): number {
  const prefix = `${key}=`;
  const found = diagnostics.find((entry) => entry.startsWith(prefix));
  if (!found) return 0;
  const value = Number(found.slice(prefix.length));
  return Number.isFinite(value) ? value : 0;
}

function sourceCounts(items: RecallItem[]): Record<string, number> {
  const counts: Record<string, number> = {
    source_hot_cache_count: 0,
    source_vector_count: 0,
    source_graph_count: 0,
    source_explicit_count: 0,
    source_hybrid_count: 0,
  };
  for (const item of items) {
    const key = item.source === "hot-cache"
      ? "source_hot_cache_count"
      : `source_${item.source}_count`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function recordRecallMetric(input: {
  butlerData: string;
  startedAt: number;
  result: AssociativeRecallResult;
  projectScoped: boolean;
}): void {
  recordOperationalMetric({
    category: "memory",
    name: "recall",
    status: "ok",
    durationMs: Date.now() - input.startedAt,
    value: input.result.items.length,
    unit: "items",
    dimensions: {
      items_count: input.result.items.length,
      seeds_count: input.result.seeds.length,
      candidates_count: numericDiagnostic(
        input.result.diagnostics,
        "candidates",
      ),
      activated_nodes_count: numericDiagnostic(
        input.result.diagnostics,
        "activated_nodes",
      ),
      shadow_baseline_items_count: 0,
      shadow_recall_gain_count: input.result.items.length,
      abstained: input.result.abstained,
      project_scoped: input.projectScoped,
      ...sourceCounts(input.result.items),
    },
  }, {
    butlerData: input.butlerData,
  });
}

function recordRecallError(input: {
  butlerData: string;
  startedAt: number;
  projectScoped: boolean;
}): void {
  recordOperationalMetric({
    category: "memory",
    name: "recall",
    status: "error",
    durationMs: Date.now() - input.startedAt,
    dimensions: {
      project_scoped: input.projectScoped,
    },
  }, {
    butlerData: input.butlerData,
  });
}

function fileCandidate(input: {
  id: string;
  path: string;
  text: string;
  summary?: string;
  source: RecallCandidate["source"];
  originalSource: RecallCandidate["originalSource"];
  explicitSalience?: number;
}): RecallCandidate {
  return {
    id: input.id,
    summary: input.summary ?? compact(input.text, FILE_CANDIDATE_SUMMARY_CHARS),
    text: input.text,
    source: input.source,
    originalSource: input.originalSource,
    explicitSalience: input.explicitSalience,
    provenance: [input.path],
  };
}

export function markdownMemoryBlocks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^#{1,6}\s+\S/u.test(line) && current.some((entry) => entry.trim())) {
      blocks.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }

  if (current.some((entry) => entry.trim())) {
    blocks.push(current.join("\n").trim());
  }
  const usable = blocks.filter((block) => block.trim());
  return usable.length > 1 ? usable : [text.trim()].filter(Boolean);
}

function hotCacheFileCandidates(input: {
  path: string;
  text: string;
}): RecallCandidate[] {
  return markdownMemoryBlocks(input.text).map((block, index) =>
    fileCandidate({
      id: `hot:${input.path}#block-${index + 1}`,
      path: `${input.path}#block-${index + 1}`,
      text: block,
      source: "hot-cache",
      originalSource: "hot-cache",
    }),
  );
}

function loadGraphCandidates(input: {
  butlerData: string;
  projectId?: string;
}): {
  nodes: RecallNode[];
  edges: RecallEdge[];
  candidates: RecallCandidate[];
} {
  const { butlerData, projectId } = input;
  const path = join(cognitionMemoryRoot(butlerData), "db", "graph.sqlite");
  if (!existsSync(path)) return { nodes: [], edges: [], candidates: [] };
  try {
    const db = new Database(path, { readonly: true });
    try {
      const nodes = db.prepare(`
        SELECT e.id, e.type, e.name, COUNT(edge.id) AS degree
        FROM memory_nodes e
        LEFT JOIN edges edge ON edge.source_id = e.id OR edge.target_id = e.id
        GROUP BY e.id
      `).all() as Array<
        { id: string; type: string; name: string; degree: number }
      >;
      const edges = db.prepare(`
        SELECT source_id AS sourceId, target_id AS targetId, rel_type AS relType, weight
        FROM edges
      `).all() as RecallEdge[];
      const projectWhere = projectId
        ? "AND (m.project = ? OR e.project = ?)"
        : "";
      const mentionParams = projectId ? [projectId, projectId] : [];
      const mentions = db.prepare(`
        SELECT m.id, m.node_id, m.session_id, m.timestamp, m.snippet, e.name
        FROM memory_evidence m
        JOIN memory_nodes e ON e.id = m.node_id
        WHERE m.snippet IS NOT NULL AND length(m.snippet) > 0
        ${projectWhere}
        ORDER BY m.timestamp DESC
        LIMIT 200
      `).all(...mentionParams) as Array<{
        id: number;
        node_id: string;
        session_id: string;
        timestamp: number;
        snippet: string;
        name: string;
      }>;
      const groupedMentions = new Map<string, {
        id: number;
        session_id: string;
        timestamp: number;
        snippet: string;
        entityIds: string[];
      }>();
      for (const mention of mentions) {
        const key = `${mention.session_id}\u0000${mention.snippet}`;
        const existing = groupedMentions.get(key);
        if (existing) {
          existing.timestamp = Math.max(existing.timestamp, mention.timestamp);
          if (!existing.entityIds.includes(mention.node_id)) {
            existing.entityIds.push(mention.node_id);
          }
          continue;
        }
        groupedMentions.set(key, {
          id: mention.id,
          session_id: mention.session_id,
          timestamp: mention.timestamp,
          snippet: mention.snippet,
          entityIds: [mention.node_id],
        });
      }
      return {
        nodes,
        edges,
        candidates: [...groupedMentions.values()].map((mention) => ({
          id: `graph:${mention.id}`,
          summary: compact(mention.snippet, 180),
          text: mention.snippet,
          source: "graph",
          originalSource: "graph",
          provenance: [`graph:${mention.session_id}`],
          relatedNodes: mention.entityIds,
          timestamp: mention.timestamp,
          frequency: 1,
        })),
      };
    } finally {
      db.close();
    }
  } catch {
    return { nodes: [], edges: [], candidates: [] };
  }
}

export function loadRecallCorpus(
  input: { butlerData: string; projectId?: string },
): RecallCorpus {
  const memoryDir = cognitionMemoryRoot(input.butlerData);
  const hotDir = join(memoryDir, "hot");
  const projectId = input.projectId?.trim();
  const candidates: RecallCandidate[] = [];
  const hotCacheHints: string[] = [];

  for (
    const path of [
      ...listFiles(hotDir, (name) => name.endsWith(".md")),
      ...listFiles(join(hotDir, "topics"), (name) => name.endsWith(".md")),
    ]
  ) {
    const text = readText(path);
    if (!text.trim()) continue;
    const hotCandidates = hotCacheFileCandidates({ path, text });
    hotCacheHints.push(
      ...hotCandidates.map((candidate) =>
        compact(candidate.text, HOT_CACHE_HINT_CHARS),
      ),
    );
    candidates.push(...hotCandidates);
  }

  const taskMemoryDir = join(memoryDir, "tasks");
  for (const path of listFiles(taskMemoryDir, (name) => name.endsWith(".md"))) {
    const text = readText(path);
    if (!text.trim()) continue;
    if (projectId && !text.toLowerCase().includes(projectId.toLowerCase())) {
      continue;
    }
    candidates.push(fileCandidate({
      id: `task:${path}`,
      path,
      text,
      source: "task-memory",
      originalSource: "task-memory",
    }));
  }

  const projectMemoryDir = join(memoryDir, "projects");
  const safeProjectId = projectId ? sanitizeProjectMemoryId(projectId) : null;
  for (
    const path of listFiles(projectMemoryDir, (name) => name.endsWith(".md"))
  ) {
    if (safeProjectId && basename(path, ".md") !== safeProjectId) continue;
    const text = readText(path);
    if (!text.trim()) continue;
    candidates.push(fileCandidate({
      id: `project:${path}`,
      path,
      text,
      source: "project-memory",
      originalSource: "project-memory",
    }));
  }

  const rulesDir = join(memoryDir, "rules");
  for (const path of listFiles(rulesDir, (name) => name.endsWith(".md"))) {
    const text = readText(path);
    if (!text.trim()) continue;
    candidates.push(fileCandidate({
      id: `rule:${path}`,
      path,
      text,
      source: "explicit",
      originalSource: "rules",
      explicitSalience: 1,
    }));
  }

  const graph = loadGraphCandidates({
    butlerData: input.butlerData,
    projectId,
  });
  return {
    hotCacheHints,
    nodes: graph.nodes,
    edges: graph.edges,
    candidates: [...candidates, ...graph.candidates],
  };
}

export function recallMemory(input: {
  butlerData: string;
  cue: string;
  projectId?: string;
  context?: RecallContextInput;
  evidencePolicy?: RecallEvidencePolicy;
  rankingPolicy?: RecallEvidencePolicy;
  limit?: number;
  now?: number;
  minScore?: number;
}): AssociativeRecallResult {
  const startedAt = Date.now();
  try {
    const result = recallFromCorpus({
      cue: input.cue,
      corpus: loadRecallCorpus({
        butlerData: input.butlerData,
        projectId: input.projectId,
      }),
      context: input.context,
      evidencePolicy: input.evidencePolicy,
      rankingPolicy: input.rankingPolicy,
      limit: input.limit,
      now: input.now,
      minScore: input.minScore,
    });
    recordRecallMetric({
      butlerData: input.butlerData,
      startedAt,
      result,
      projectScoped: Boolean(input.projectId?.trim()),
    });
    return result;
  } catch (error) {
    recordRecallError({
      butlerData: input.butlerData,
      startedAt,
      projectScoped: Boolean(input.projectId?.trim()),
    });
    throw error;
  }
}

export async function recallMemoryWithVector(input: {
  butlerData: string;
  cue: string;
  projectId?: string;
  context?: RecallContextInput;
  evidencePolicy?: RecallEvidencePolicy;
  rankingPolicy?: RecallEvidencePolicy;
  vectorQueries?: string[];
  vectorBackend?: VectorEpisodeBackend;
  vectorTimeoutMs?: number;
  limit?: number;
  now?: number;
  minScore?: number;
}): Promise<AssociativeRecallResult> {
  const startedAt = Date.now();
  const projectScoped = Boolean(input.projectId?.trim());
  try {
    const corpus = loadRecallCorpus({
      butlerData: input.butlerData,
      projectId: input.projectId,
    });
    const vectorQueries = uniqueQueries([
      input.cue,
      ...(input.vectorQueries ?? []),
    ]).slice(0, 3);
    const vectorDiagnostics: string[] = [];
    const vectorResults = await Promise.all(
      vectorQueries.map(async (query) => ({
        query,
        result: await searchVectorEpisodes({
          butlerData: input.butlerData,
          query,
          projectId: input.projectId,
          limit: input.limit,
          timeoutMs: input.vectorTimeoutMs,
          backend: input.vectorBackend,
        }),
      })),
    );
    const vectorCandidateMap = new Map<string, RecallCandidate>();
    for (const { query, result: vectorResult } of vectorResults) {
      for (const candidate of vectorResult.candidates) {
        mergeVectorCandidate(vectorCandidateMap, candidate, query);
      }
      vectorDiagnostics.push(...vectorResult.diagnostics);
    }
    corpus.candidates.push(...vectorCandidateMap.values());
    const result = recallFromCorpus({
      cue: input.cue,
      corpus,
      context: input.context,
      evidencePolicy: input.evidencePolicy,
      rankingPolicy: input.rankingPolicy,
      limit: input.limit,
      now: input.now,
      minScore: input.minScore,
    });
    const resultWithDiagnostics = {
      ...result,
      diagnostics: [...result.diagnostics, ...vectorDiagnostics],
    };
    recordRecallMetric({
      butlerData: input.butlerData,
      startedAt,
      result: resultWithDiagnostics,
      projectScoped,
    });
    return resultWithDiagnostics;
  } catch (error) {
    recordRecallError({
      butlerData: input.butlerData,
      startedAt,
      projectScoped,
    });
    throw error;
  }
}

function uniqueQueries(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const query = value.trim();
    if (query.length < 2) continue;
    const key = query.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(query);
  }
  return output;
}

export function createCachedRecallMemoryRunner(input: {
  butlerData: string;
  ttlMs?: number;
}): typeof recallMemory & {
  recallSourceBacked(request: RecallMemoryInput): Promise<RecallMemoryResult>;
} {
  const ttlMs = Math.max(1000, input.ttlMs ?? DEFAULT_RECALL_CACHE_TTL_MS);
  let cachedAt = 0;
  let cachedCorpus: RecallCorpus | null = null;
  let cachedProjectId: string | undefined;
  const sourceBackedInventories: V2RecallInventoryCache = new Map();

  const run: typeof recallMemory = (request) => {
    const now = Date.now();
    const projectId = request.projectId?.trim() || undefined;
    if (
      !cachedCorpus || now - cachedAt > ttlMs ||
      request.butlerData !== input.butlerData || cachedProjectId !== projectId
    ) {
      cachedCorpus = loadRecallCorpus({
        butlerData: request.butlerData,
        projectId,
      });
      cachedAt = now;
      cachedProjectId = projectId;
    }
    const startedAt = Date.now();
    try {
      const result = recallFromCorpus({
        cue: request.cue,
        corpus: cachedCorpus,
        context: request.context,
        evidencePolicy: request.evidencePolicy,
        rankingPolicy: request.rankingPolicy,
        limit: request.limit,
        now: request.now,
      });
      recordRecallMetric({
        butlerData: request.butlerData,
        startedAt,
        result,
        projectScoped: Boolean(projectId),
      });
      return result;
    } catch (error) {
      recordRecallError({
        butlerData: request.butlerData,
        startedAt,
        projectScoped: Boolean(projectId),
      });
      throw error;
    }
  };
  return Object.assign(run, {
    recallSourceBacked: (request: RecallMemoryInput) =>
      recallSourceBackedMemoryWithCache(request, sourceBackedInventories),
  });
}

const cachedRecallMemoryRunner = createCachedRecallMemoryRunner({
  butlerData: "",
});

export async function recallSourceBackedMemory(
  request: RecallMemoryInput,
): Promise<RecallMemoryResult> {
  return cachedRecallMemoryRunner.recallSourceBacked(request);
}

async function recallSourceBackedMemoryWithCache(
  request: RecallMemoryInput,
  inventories: V2RecallInventoryCache,
): Promise<RecallMemoryResult> {
  const input = normalizeV2RecallInput(request);
  const deadlineAt = Date.now() + V2_RECALL_DEADLINE_MS;
  if (input.cursor) return continueV2Recall(input, deadlineAt, inventories);
  const generation = resolveMemoryGeneration(input.context);
  if (input.includeVector) {
    return await recallSourceBackedWithVector(input, generation, deadlineAt, inventories);
  }
  return recallSourceBackedGraph(input, generation, undefined, deadlineAt, inventories);
}

async function recallSourceBackedWithVector(
  input: RecallMemoryInput,
  generation: MemoryGenerationHandle,
  deadlineAt: number,
  inventories: V2RecallInventoryCache,
): Promise<RecallMemoryResult> {
  if (!generation.embedding) {
    return recallSourceBackedGraph(
      input,
      generation,
      {
        vectorCode: "embedding_not_configured",
      },
      deadlineAt,
      inventories,
    );
  }
  try {
    const vector = await searchGenerationVectors({
      butlerData: input.context.butlerData,
      generation,
      phrases: [input.cue, ...(input.vectorQueries ?? [])],
      scope: input.scope,
      projectFilter: input.projectFilter,
      projectIds: input.projectIds,
      runtimeProjectId: input.runtime.projectId,
      runtimeSessionId: input.runtime.sessionId,
      sessionIds: input.sessionIds,
      asOf: input.asOf,
      time: input.time,
      includeInternal: input.includeInternal,
      deadlineAt,
      signal: input.context.signal,
    });
    return recallSourceBackedGraph(input, generation, { vector }, deadlineAt, inventories);
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)
      ? error.message
      : "vector_unavailable";
    return recallSourceBackedGraph(
      input,
      generation,
      { vectorCode: code },
      deadlineAt,
      inventories,
    );
  }
}

function recallSourceBackedGraph(
  input: RecallMemoryInput,
  generation: MemoryGenerationHandle,
  vectorInput: {
    vector?: Awaited<ReturnType<typeof searchGenerationVectors>>;
    vectorCode?: string;
  } | undefined,
  deadlineAt: number,
  inventories: V2RecallInventoryCache,
): RecallMemoryResult {
  const db = openProjectionDb(generation.graphPath, true);
  const graphStartedAt = performance.now();
  const graphDeadlineAt = deadlineAt - V2_RECALL_SOURCE_RESERVE_MS;
  const candidateDeadlineAt = graphDeadlineAt - V2_RECALL_GRAPH_RESERVE_MS;
  try {
    // Pin graph revision for all query-local cached reads and cursor metadata.
    db.exec("BEGIN");
    const admitted = input.admittedChannels ?? {
      graph: true,
      lexical: true,
      vector: true,
      context: true,
      explicit: true,
      task: true,
    };
    const projectionCoverage = graphProjectionCoverage(db, input, generation, candidateDeadlineAt);
    const graphProjectionPending = projectionCoverage.pending;
    const currentVector = vectorInput?.vector
      ? filterCurrentVectorMatches(db, input, generation, vectorInput.vector)
      : undefined;
    const selected = selectSemanticSeeds(
      db,
      input,
      currentVector?.nodes,
      candidateDeadlineAt,
    );
    const temporal = admitted.context
      ? selectTemporalSeeds(db, input)
      : { seeds: [], episodeIds: [] };
    const semanticLimit = input.time
      ? Math.min(16 - temporal.seeds.length, 16)
      : 16;
    selected.seeds.splice(
      0,
      selected.seeds.length,
      ...selected.allSeeds.slice(0, semanticLimit),
    );
    for (const nodeId of temporal.seeds.slice(0, 16 - selected.seeds.length)) {
      if (!selected.seeds.includes(nodeId)) selected.seeds.push(nodeId);
      const channels = selected.channels.get(nodeId) ?? new Set<string>();
      channels.add("temporal");
      selected.channels.set(nodeId, channels);
    }
    const rawSources = admitted.lexical
      ? selectRawSourceCandidates(db, input, candidateDeadlineAt)
      : { sources: [], partial: false };
    const rawEpisodeIds = [...new Set(rawSources.sources.map((source) => source.episodeId))];
    const rawEpisodeSet = new Set(rawEpisodeIds);
    const exactRawEpisodes = new Set(rawSources.sources.filter((source) => source.exactMatch).map((source) => source.episodeId));
    if (rawSources.partial) selected.coverageCodes.push("lexical_partial");
    const directEpisodeIds = [
      ...new Set([
        ...(currentVector?.episodes.map((item) => item.ownerId) ?? []),
        ...temporal.episodeIds,
        ...rawEpisodeIds,
      ]),
    ];
    if (selected.seeds.length === 0 && directEpisodeIds.length === 0) {
      recordV2Stage(input, "recall_v2_graph_read_ppr", graphStartedAt);
      return emptyV2Recall(input, {
        vectorCode: vectorInput?.vectorCode ??
          (generation.embedding ? "no_hits" : "embedding_not_configured"),
        vectorDiagnostics: vectorInput?.vector?.diagnostics ?? [],
        graphCodes: projectionCoverage.codes,
        selectionCodes: selected.coverageCodes,
        vectorPartial: Boolean(currentVector?.partial),
        deadlineHit: Date.now() >= deadlineAt,
      });
    }
    const identityScope = {
      butlerData: generation.sourceRoot,
      asOf: input.asOf,
      scope: input.scope,
      currentSessionId: input.runtime.sessionId,
      currentProjectId: input.runtime.projectId,
      sessionIds: input.sessionIds,
      projectFilter: input.projectFilter,
      projectIds: input.projectIds,
      includeInternal: input.includeInternal,
      deadlineAt: graphDeadlineAt,
    };
    const resolvedSeedResults = selected.seeds.map((seed) =>
      resolveIdentityAt(db, seed, identityScope),
    );
    if (resolvedSeedResults.some((result) => result.partial)) {
      selected.coverageCodes.push("identity_partial");
    }
    const resolvedSeeds = resolvedSeedResults.map((result) => result.nodeId);
    const adjacencyCache = new Map<string, ReturnType<typeof loadEligibleAdjacency>>();
    const expansion = expandGraph(
      [...new Set(resolvedSeeds)],
      (nodeId, limit, offset) => {
        if (!admitted.graph) return { edges: [], truncated: false };
        const key = JSON.stringify([nodeId, limit, offset]);
        let page = adjacencyCache.get(key);
        if (!page) {
          page = loadEligibleAdjacency(db, input, nodeId, limit, offset);
          adjacencyCache.set(key, page);
        }
        return page;
      },
      graphDeadlineAt,
      (nodeId, limit) =>
        identityMembersForTarget(db, nodeId, { ...identityScope, limit }),
    );
    const reachable = [...expansion.paths.keys()];
    const mentions = loadEligibleMentions(db, input, reachable);
    const directMentions = loadEligibleMentionsForEpisodes(
      db,
      input,
      directEpisodeIds,
    );
    for (const mention of directMentions) {
      if (
        !mentions.some((item) =>
          item.sourceId === mention.sourceId && item.nodeId === mention.nodeId,
        )
      ) mentions.push(mention);
    }
    const episodesWithMentions = new Set(
      directMentions.map((mention) => mention.episodeId),
    );
    mentions.push(
      ...loadEligibleEpisodeSources(
        db,
        input,
        directEpisodeIds.filter((episodeId) =>
          !episodesWithMentions.has(episodeId),
        ),
      ),
    );
    // A raw hit stays searchable even when other spans already have model claims.
    const rawSourceIds = new Set(rawSources.sources.map((source) => source.sourceId));
    for (const source of loadEligibleEpisodeSources(db, input, rawEpisodeIds)) {
      if (rawSourceIds.has(source.sourceId) && !mentions.some((mention) => mention.sourceId === source.sourceId)) mentions.push(source);
    }
    const episodeNodes = new Map<string, RecallMention[]>();
    for (const mention of mentions) {
      const values = episodeNodes.get(mention.episodeId) ?? [];
      values.push(mention);
      episodeNodes.set(mention.episodeId, values);
    }
    const episodeIds = [...episodeNodes.keys()];
    const graphScores = new Map(
      episodeIds.map((
        episodeId,
      ) => [
        episodeId,
        Math.max(
          0,
          ...episodeNodes.get(episodeId)!
            .filter((mention) =>
              mention.relation !== "supports" &&
              nodeType(db, mention.nodeId) !== "project",
            )
            .map((mention) => expansion.relevance.get(mention.nodeId) ?? 0),
        ),
      ]),
    );
    const lexicalScores = new Map(
      episodeIds.map((
        episodeId,
      ) => [
        episodeId,
        Math.max(
          0,
          ...episodeNodes.get(episodeId)!
            .map((mention) =>
              selected.scores.get(mention.nodeId)?.get("lexical") ?? 0,
            ),
        ),
      ]),
    );
    for (const source of rawSources.sources) {
      lexicalScores.set(source.episodeId, Math.max(lexicalScores.get(source.episodeId) ?? 0, source.score));
    }
    const contextScores = new Map(
      episodeIds.map((
        episodeId,
      ) => [
        episodeId,
        Math.max(
          0,
          ...episodeNodes.get(episodeId)!
            .map((mention) => {
              const rank = selected.ranks.get(mention.nodeId)?.get("context");
              return rank === undefined ? 0 : 1 / rank;
            }),
        ),
      ]),
    );
    temporal.episodeIds.forEach((episodeId, index) =>
      contextScores.set(
        episodeId,
        Math.max(contextScores.get(episodeId) ?? 0, 1 / (index + 1)),
      ),
    );
    const graphList = admitted.graph ? rankedIds(graphScores) : [];
    const lexicalCandidates = rankedIds(lexicalScores);
    const lexicalList = admitted.lexical ? lexicalCandidates : [];
    const contextList = admitted.context ? rankedIds(contextScores) : [];
    const vectorList = admitted.vector
      ? currentVector?.episodes.map((item) => item.ownerId).slice(0, 128) ?? []
      : [];
    const fused = fuseEpisodeCandidates({
      graph: graphList,
      vector: vectorList,
      lexical: admitted.explicit && !admitted.lexical
        ? lexicalCandidates
        : lexicalList,
      context: contextList,
    });
    const rows = episodeRows(db, input, fused.episodeIds, rawEpisodeSet).map((row) => {
      const relationships = episodeRelationshipState(db, input, row.episodeId);
      return {
        ...row,
        ...relationships,
        explicitPriority: relationships.explicitPriority,
        qualifications: [
          ...new Set([
            ...(row.historical ? ["historical"] : []),
            ...relationships.qualifications,
          ]),
        ],
        supportCount: supportCountForEpisode(db, input, row.episodeId),
      };
    }).filter((row) => !row.superseded || rawEpisodeSet.has(row.episodeId));
    const graphRanks = rankMap(graphList),
      lexicalRanks = rankMap(lexicalList),
      contextRanks = rankMap(contextList);
    const executedChannels = {
      graph: admitted.graph,
      vector: admitted.vector && input.includeVector && Boolean(currentVector),
      lexical: admitted.lexical &&
        !selected.coverageCodes.includes("lexical_partial"),
      context: admitted.context,
    };
    const ranked = diversifyBySession(
      rankEpisodes(
        rows.map((row) => ({
          episodeId: row.episodeId,
          sessionId: row.sessionId,
          conversationAt: row.conversationAt,
          eventAt: row.eventAt,
          graphRank: admitted.graph
            ? graphRanks.get(row.episodeId)
            : undefined,
          lexicalRank: admitted.lexical
            ? lexicalRanks.get(row.episodeId)
            : undefined,
          contextRank: admitted.context
            ? contextRanks.get(row.episodeId)
            : undefined,
          vectorRank: admitted.vector
            ? currentVector?.episodes.find((item) =>
              item.ownerId === row.episodeId,
            )?.rank
            : undefined,
          explicitPriority: admitted.explicit && Boolean(row.explicitPriority),
          salience: row.salience,
          supportCount: row.supportCount,
          halfLifeDays: row.halfLifeDays,
        })),
        executedChannels,
        input.asOf,
        input.time?.basis ?? "conversation",
      ),
      128,
    );
    // Direct original quotations take precedence over merely associated concepts.
    ranked.sort((a, b) => Number(exactRawEpisodes.has(b.episodeId)) - Number(exactRawEpisodes.has(a.episodeId)));
    recordV2Stage(input, "recall_v2_graph_read_ppr", graphStartedAt);
    recordV2CandidateRankingMetrics({
      input,
      generationId: generation.generationId,
      ranked,
      graphScores,
      lexicalScores,
      contextScores,
      vectorMatches: currentVector?.episodes ?? [],
      graphRanks,
      lexicalRanks,
      contextRanks,
      executedChannels,
    });
    const allSourceIds = [
      ...new Set(ranked.flatMap((episode) =>
        episodeNodes.get(episode.episodeId)?.map((mention) =>
          mention.sourceId,
        ) ?? [],
      )),
    ];
    const allProjectionSources = sourceRows(db, allSourceIds);
    const excludedSources = excludedMemorySourceIds(generation.sourceRoot, {
      db,
      generationId: generation.generationId,
      sources: allProjectionSources,
    });
    const projectionSources = allProjectionSources
      .filter((source) => !excludedSources.has(source.source_id));
    const sourceById = new Map(
      projectionSources.map((source) => [source.source_id, source]),
    );
    const hydrationStartedAt = performance.now();
    const hydrated = hydrateSources(
      generation.sourceRoot,
      projectionSources,
      480,
      deadlineAt,
      rows.map((row) => ({
        episodeId: row.episodeId,
        revision: row.revision,
        sessionId: row.sessionId,
        turnId: row.turnId,
      })),
    );
    recordV2Stage(input, "recall_v2_source_hydration", hydrationStartedAt);
    const candidateResults: RecallMemoryResult["results"] = [];
    const failedSourceIds = new Set<string>();
    let sourceDeadlineHit = false;
    let resultBudgetHit = false;
    const bindResultToEvidence = (
      rankedEpisode: (typeof ranked)[number],
      evidence: RecallMemoryResult["results"][number]["evidence"],
    ): RecallMemoryResult["results"][number] | null => {
      const row = rows.find((item) =>
        item.episodeId === rankedEpisode.episodeId,
      )!;
      const episodeMentions = episodeNodes.get(row.episodeId)!;
      const survivingSources = new Set(
        evidence.map((item) =>
          rawMemorySourceId(item.source_ref),
        ),
      );
      const matched = episodeMentions
        .filter((mention) =>
          mention.relation !== "supports" &&
          (!rawEpisodeSet.has(row.episodeId) || expansion.paths.has(mention.nodeId)) &&
          survivingSources.has(mention.sourceId),
        )
        .slice()
        .sort((a, b) => {
          const pathDelta = (expansion.paths.get(a.nodeId)?.length ??
            Number.POSITIVE_INFINITY) -
            (expansion.paths.get(b.nodeId)?.length ?? Number.POSITIVE_INFINITY);
          return pathDelta ||
            (expansion.relevance.get(b.nodeId) ?? 0) -
              (expansion.relevance.get(a.nodeId) ?? 0) ||
            Buffer.compare(Buffer.from(a.nodeId), Buffer.from(b.nodeId));
        })[0]?.nodeId ?? null;
      const interpretedSummary = row.hasClaims
        ? matchedClaimSummary(
          db,
          input,
          row.episodeId,
          matched,
          episodeMentions,
          survivingSources,
        )
        : null;
      const rawEvidence = evidence.find((item) => rawSourceIds.has(rawMemorySourceId(item.source_ref)));
      const summary = interpretedSummary || rawEvidence?.excerpt || evidence[0]?.excerpt;
      if (!summary) return null;
      const result: V2RecallResultItem = {
        requirements: resultRequirements(db, input, evidence),
        interpretations: resultInterpretations(db, input, evidence),
        current_state_requires_verification: true,
        episode_ref: row.episodeId,
        revision: row.revision,
        summary,
        occurred_at: row.eventAt,
        conversation_at: row.conversationAt,
        channels: [
          ...rankedEpisode.channels,
          ...(input.admittedChannels?.explicit === true &&
              [...survivingSources].some((sourceId) =>
                row.explicitRuleSourceIds.has(sourceId),
              )
            ? ["explicit" as const]
            : []),
        ],
        matched_node_ref: matched,
        association_path: matched ? expansion.paths.get(matched) ?? [] : [],
        evidence,
        qualifications: [
          ...(row.qualifications as string[]),
          ...(!interpretedSummary ? ["unclassified_source"] : ["model_interpretation"]),
          ...(rawEvidence ? ["raw_source_match"] : []),
          ...(evidence.some((item) =>
              sourceById.get(rawMemorySourceId(item.source_ref))
                ?.origin_kind === "unknown",
            )
            ? ["uncertain"]
            : []),
        ],
      };
      Object.defineProperty(result, recallResultEvidenceFacts, {
        value: {
          projectIds: row.projectId === null
            ? new Set<string>()
            : new Set([row.projectId]),
          recentSourceHit: [...survivingSources].some((sourceId) =>
            selected.contextSourceIds.has(sourceId),
          ),
          explicitRuleSourceHit: [...survivingSources].some((sourceId) =>
            row.explicitRuleSourceIds.has(sourceId),
          ),
        } satisfies RecallResultEvidenceFacts,
      });
      return result;
    };
    for (const rankedEpisode of ranked) {
      const row = rows.find((item) =>
        item.episodeId === rankedEpisode.episodeId,
      )!;
      const episodeMentions = episodeNodes.get(row.episodeId)!;
      const hydratedMentions = episodeMentions.filter((mention) => {
        if (hydrated.get(mention.sourceId)?.value) return true;
        if (
          hydrated.get(mention.sourceId)?.error === "memory_source_deadline"
        ) sourceDeadlineHit = true;
        else failedSourceIds.add(mention.sourceId);
        return false;
      });
      const evidence: RecallMemoryResult["results"][number]["evidence"] = [];
      for (
        const mention of hydratedMentions.slice().sort((a, b) =>
          Number(rawSourceIds.has(b.sourceId)) - Number(rawSourceIds.has(a.sourceId)) || compareEvidenceHandles(
            sourceById.get(a.sourceId),
            sourceById.get(b.sourceId),
            row.prioritySourceIds,
          ),
        )
      ) {
        if (
          evidence.some((item) =>
            rawMemorySourceId(item.source_ref) === mention.sourceId,
          )
        ) continue;
        const source = hydrated.get(mention.sourceId)?.value;
        if (source) {
          const sourceRef = memorySourceHandle(
            generation.generationId,
            source.source_ref,
          );
          evidence.push({
            source_ref: sourceRef,
            basis: source.basis,
            source_kind: source.source_kind,
            excerpt: rawSourceIds.has(mention.sourceId)
              ? rawSourceExcerpt(source.text, [input.cue, ...(input.seedPhrases ?? [])])
              : source.excerpt,
            source_resolved: true,
            conversation_session_id: source.conversation_session_id,
            conversation_message_id: source.conversation_message_id,
            support: {
              node_ref: mention.nodeId,
              relation: mention.relation ?? "mentions",
            },
            read_args: recallReadArgs(input, sourceRef),
          });
          if (evidence.length >= 3) break;
        }
      }
      if (evidence.length === 0) continue;
      const result = bindResultToEvidence(rankedEpisode, evidence);
      if (result) candidateResults.push(result);
    }
    const graphRevision = db.query<{ value: string }, []>(
      "SELECT value FROM memory_state WHERE key='graph_revision'",
    ).get()?.value ?? "0";
    const cursorPage = v2RecallCursorPage(
      input,
      generation.generationId,
      graphRevision,
      candidateResults,
      inventories,
    );
    const results: RecallMemoryResult["results"] = [];
    let nextResultOffset = 0;
    const buildResponse = (): RecallMemoryResult => {
      const deadlineHit = Date.now() >= deadlineAt;
      const partial = graphProjectionPending ||
        projectionCoverage.codes.length > 0 || failedSourceIds.size > 0 ||
        sourceDeadlineHit ||
        resultBudgetHit || selected.coverageCodes.length > 0 ||
        expansion.coverageCodes.length > 0 || currentVector?.partial ||
        fused.candidateLimit || deadlineHit || Boolean(vectorInput?.vectorCode);
      const executionIncomplete = graphProjectionPending ||
        projectionCoverage.codes.length > 0 || failedSourceIds.size > 0 ||
        sourceDeadlineHit || resultBudgetHit || deadlineHit ||
        Boolean(vectorInput?.vectorCode) || Boolean(currentVector?.partial) ||
        selected.coverageCodes.length > 0 ||
        expansion.coverageCodes.length > 0 || fused.candidateLimit;
      return {
        status: deriveRecallStatus(
          results.length,
          partial,
          executionIncomplete,
        ),
        results,
        coverage: {
          graph: admitted.graph
            ? {
            state: graphProjectionPending || projectionCoverage.codes.length ||
                expansion.coverageCodes.length ||
                selected.coverageCodes.length || fused.candidateLimit ||
                deadlineHit
              ? "partial"
              : "ok",
            candidates: ranked.length,
            codes: [
              ...projectionCoverage.codes,
              ...selected.coverageCodes,
              ...expansion.coverageCodes,
              ...(fused.candidateLimit ? ["candidate_limit"] : []),
              ...(deadlineHit ? ["operation_deadline"] : []),
            ],
          }
            : { state: "disabled_by_request", candidates: 0, codes: [] },
          vectors: input.includeVector
            ? vectorInput?.vector
              ? {
                state: currentVector?.partial ? "partial" : "ok",
                candidates: (currentVector?.nodes.length ?? 0) +
                  (currentVector?.episodes.length ?? 0),
                codes: currentVector?.partial
                  ? ["vector_current_rows_missing"]
                  : [],
              }
              : {
                state: "unavailable",
                candidates: 0,
                codes: [vectorInput?.vectorCode ?? "embedding_not_configured"],
              }
            : { state: "disabled_by_request", candidates: 0, codes: [] },
          source: {
            state: projectionCoverage.codes.length || failedSourceIds.size ||
                sourceDeadlineHit || resultBudgetHit
              ? "partial"
              : "ok",
            candidates: [...hydrated.values()].filter((item) =>
              item.value,
            ).length,
            codes: [
              ...projectionCoverage.codes,
              ...(failedSourceIds.size ? ["source_resolution_failed"] : []),
              ...(sourceDeadlineHit ? ["operation_deadline"] : []),
              ...(resultBudgetHit ? ["serialization_budget"] : []),
            ],
          },
        },
        next_cursor: nextResultOffset < cursorPage.candidateCount
          ? encodeRecallCursor(cursorPage.key, nextResultOffset) : null,
        diagnostics: vectorInput?.vector?.diagnostics ?? [],
      };
    };
    // Give every ranked result a complete, source-backed bundle before spending
    // the envelope on supplementary evidence for the first few results.
    let response = buildResponse();
    for (const [index, result] of candidateResults.entries()) {
      const rankedEpisode = ranked.find((item) => item.episodeId === result.episode_ref)!;
      const minimum = minimumRecallBundle(result, (evidence) => bindResultToEvidence(rankedEpisode, evidence));
      results.push(minimum);
      nextResultOffset = index + 1;
      if (memoryRecallNativeEnvelopeBytes(buildResponse()) > V2_RECALL_ENVELOPE_BYTES) {
        results.pop();
        resultBudgetHit = true;
        if (results.length) { nextResultOffset = index; break; }
        // A complete bundle that cannot fit alone is omitted with coverage.
        // Advance past it so a cursor cannot loop forever on the same item.
        continue;
      }
      if (results.length >= input.limit) break;
    }
    for (let index = 0; index < results.length; index += 1) {
      const minimum = results[index]!;
      results[index] = candidateResults.find((item) => item.episode_ref === minimum.episode_ref)!;
      if (memoryRecallNativeEnvelopeBytes(buildResponse()) > V2_RECALL_ENVELOPE_BYTES) results[index] = minimum;
    }
    response = buildResponse();
    const inventory = inventories.get(cursorPage.key)!;
    inventory.status = response.status;
    inventory.coverage = response.coverage;
    inventory.diagnostics = response.diagnostics;
    if (!response.next_cursor) inventories.delete(cursorPage.key);
    recordV2ReturnedRankingMetrics({
      input,
      generationId: generation.generationId,
      results: response.results,
      candidateRanks: rankMap(ranked.map((episode) => episode.episodeId)),
      executedChannels,
    });
    return response;
  } finally {
    if (db.inTransaction) db.exec("ROLLBACK");
    db.close();
  }
}

function truncateRecallExcerpt(value: string, maxGraphemes: number): string {
  return [
    ...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value),
  ]
    .slice(0, maxGraphemes).map((part) => part.segment).join("");
}

function v2RecallArgumentHash(input: RecallMemoryInput): string {
  return sha256(JSON.stringify({
    cue: input.cue,
    seedPhrases: input.seedPhrases ?? [],
    vectorQueries: input.vectorQueries ?? [],
    includeVector: input.includeVector,
    includeInternal: input.includeInternal,
    admittedChannels: input.admittedChannels ?? null,
    limit: input.limit,
    scope: input.scope,
    projectFilter: input.projectFilter,
    projectIds: input.projectIds,
    sessionIds: input.sessionIds,
    time: input.time ?? null,
    asOf: input.asOf,
    runtime: {
      sessionId: input.runtime.sessionId,
      projectId: input.runtime.projectId,
    },
  }));
}

function recallInventoryFromCursor(
  cursor: string,
  inventories: V2RecallInventoryCache,
): {
  key: string;
  offset: number;
  inventory: V2RecallInventory;
} {
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid_arguments");
  }
  if (
    parsed?.schema !== "butler.recall-cursor.v2" ||
    typeof parsed.key !== "string" || !Number.isSafeInteger(parsed.offset) ||
    parsed.offset < 0
  ) throw new Error("invalid_arguments");
  const now = Date.now();
  for (const [key, value] of inventories) {
    if (now - value.createdAt > V2_RECALL_CURSOR_TTL_MS) {
      inventories.delete(key);
    }
  }
  const inventory = inventories.get(parsed.key);
  if (!inventory) throw new Error("cursor_expired");
  inventories.delete(parsed.key);
  inventories.set(parsed.key, inventory);
  return { key: parsed.key, offset: parsed.offset, inventory };
}

function continueV2Recall(
  input: RecallMemoryInput,
  deadlineAt: number,
  inventories: V2RecallInventoryCache,
): RecallMemoryResult {
  const cursor = recallInventoryFromCursor(input.cursor!, inventories);
  const generation = resolveMemoryGeneration(input.context);
  if (generation.generationId !== cursor.inventory.generationId) {
    throw new Error("stale_cursor");
  }
  const effective = { ...input, asOf: cursor.inventory.asOf };
  if (
    input.asOfExplicit && input.asOf !== cursor.inventory.asOf ||
    v2RecallArgumentHash(effective) !== cursor.inventory.argumentHash
  ) throw new Error("stale_cursor");
  const db = openProjectionDb(generation.graphPath, true);
  try {
    // Pin graph revision for all query-local cached reads and cursor metadata.
    db.exec("BEGIN");
    const graphRevision = db.query<{ value: string }, []>(
      "SELECT value FROM memory_state WHERE key='graph_revision'",
    ).get()?.value ?? "0";
    if (graphRevision !== cursor.inventory.graphRevision) {
      throw new Error("stale_cursor");
    }
    const page = cursor.inventory.candidates.slice(
      cursor.offset,
      cursor.offset + input.limit,
    );
    const ids = page.map((item) => item.episode_ref);
    const rawEpisodes = new Set(page.filter((item) => item.qualifications.includes("raw_source_match")).map((item) => item.episode_ref));
    const rows = episodeRows(db, effective, ids, rawEpisodes);
    const rowById = new Map(rows.map((row) => [row.episodeId, row]));
    const mentions = [
      ...loadEligibleMentionsForEpisodes(db, effective, ids),
      ...loadEligibleEpisodeSources(db, effective, ids),
    ];
    const sourceIds = [...new Set(mentions.map((item) => item.sourceId))];
    const allProjections = sourceRows(db, sourceIds);
    const excludedSources = excludedMemorySourceIds(generation.sourceRoot, {
      db,
      generationId: generation.generationId,
      sources: allProjections,
    });
    const projections = allProjections
      .filter((source) => !excludedSources.has(source.source_id));
    const hydrated = hydrateSources(
      generation.sourceRoot,
      projections,
      480,
      deadlineAt,
      rows.map((row) => ({
        episodeId: row.episodeId,
        revision: row.revision,
        sessionId: row.sessionId,
        turnId: row.turnId,
      })),
    );
    const sourceById = new Map(
      projections.map((source) => [source.source_id, source]),
    );
    let sourcePartial = false;
    const results: RecallMemoryResult["results"] = [];
    const resultOffsets: number[] = [];
    for (const [pageIndex, metadata] of page.entries()) {
      const row = rowById.get(metadata.episode_ref);
      if (!row || row.revision !== metadata.revision) {
        sourcePartial = true;
        continue;
      }
      const relationships = episodeRelationshipState(
        db,
        effective,
        row.episodeId,
      );
      if (relationships.superseded && !rawEpisodes.has(row.episodeId)) {
        sourcePartial = true;
        continue;
      }
      const episodeMentions = mentions.filter((item) =>
        item.episodeId === row.episodeId,
      );
      const evidence: RecallMemoryResult["results"][number]["evidence"] = [];
      for (
        const mention of episodeMentions.slice().sort((a, b) =>
          compareEvidenceHandles(
            sourceById.get(a.sourceId),
            sourceById.get(b.sourceId),
            relationships.prioritySourceIds,
          ),
        )
      ) {
        if (
          evidence.some((item) =>
            rawMemorySourceId(item.source_ref) === mention.sourceId,
          )
        ) continue;
        const source = hydrated.get(mention.sourceId)?.value;
        if (!source) {
          sourcePartial = true;
          continue;
        }
        const sourceRef = memorySourceHandle(
          generation.generationId,
          source.source_ref,
        );
        evidence.push({
          source_ref: sourceRef,
          basis: source.basis,
          source_kind: source.source_kind,
          excerpt: source.excerpt,
          source_resolved: true,
          conversation_session_id: source.conversation_session_id,
          conversation_message_id: source.conversation_message_id,
          support: {
            node_ref: mention.nodeId,
            relation: mention.relation ?? "mentions",
          },
          read_args: recallReadArgs(effective, sourceRef),
        });
        if (evidence.length >= 3) break;
      }
      if (!evidence.length) {
        sourcePartial = true;
        continue;
      }
      const surviving = new Set(
        evidence.map((item) => rawMemorySourceId(item.source_ref)),
      );
      const interpreted = row.hasClaims
        ? matchedClaimSummary(
          db,
          effective,
          row.episodeId,
          metadata.matched_node_ref,
          episodeMentions,
          surviving,
        )
        : null;
      const summary = interpreted || evidence[0]?.excerpt;
      if (!summary) {
        sourcePartial = true;
        continue;
      }
      results.push({
        interpretations: resultInterpretations(db, effective, evidence), current_state_requires_verification: true, requirements: resultRequirements(db, effective, evidence),
        episode_ref: row.episodeId,
        revision: row.revision,
        summary,
        occurred_at: row.eventAt,
        conversation_at: row.conversationAt,
        channels: metadata.channels,
        matched_node_ref: metadata.matched_node_ref,
        association_path: metadata.association_path,
        evidence,
        qualifications: [
          ...(row.historical ? ["historical"] : []),
          ...relationships.qualifications,
          ...(evidence.some((item) =>
              sourceById.get(rawMemorySourceId(item.source_ref))
                ?.origin_kind === "unknown",
            )
            ? ["uncertain"]
            : []),
        ],
      });
      resultOffsets.push(pageIndex);
    }
    const build = (budgetTrimmed: boolean): RecallMemoryResult => {
      const nextOffset = budgetTrimmed && resultOffsets.length
        ? cursor.offset + resultOffsets.at(-1)! + 1
        : cursor.offset + page.length;
      const next = nextOffset < cursor.inventory.candidates.length
        ? encodeRecallCursor(cursor.key, nextOffset)
        : null;
      const prior = cursor.inventory.coverage;
      const sourceCodes = [
        ...new Set([
          ...(prior?.source.codes ?? []),
          ...(sourcePartial ? ["source_resolution_failed"] : []),
          ...(budgetTrimmed ? ["serialization_budget"] : []),
        ]),
      ];
      return {
        status:
          cursor.inventory.status === "unavailable" && results.length === 0
            ? "unavailable"
            : cursor.inventory.status === "partial" || sourcePartial || budgetTrimmed ||
                Boolean(next)
            ? "partial"
            : "complete",
        results,
        coverage: {
          graph: prior?.graph ?? {
            state: "ok",
            candidates: cursor.inventory.candidates.length,
            codes: [],
          },
          vectors: prior?.vectors ?? (effective.includeVector
            ? {
              state: "ok",
              candidates: cursor.inventory.candidates.filter((item) =>
                item.channels.includes("vector"),
              ).length,
              codes: [],
            }
            : { state: "disabled_by_request", candidates: 0, codes: [] }),
          source: {
            state: sourceCodes.length ? "partial" : prior?.source.state ?? "ok",
            candidates: results.length,
            codes: sourceCodes,
          },
        },
        next_cursor: next,
        diagnostics: cursor.inventory.diagnostics ?? [],
      };
    };
    const fullResults = results.slice();
    const fullOffsets = resultOffsets.slice();
    results.length = 0;
    resultOffsets.length = 0;
    let budgetTrimmed = false;
    for (const [index, result] of fullResults.entries()) {
      const minimum = minimumRecallBundle(result, (evidence) => {
        const row = rowById.get(result.episode_ref)!;
        const interpreted = row.hasClaims
          ? matchedClaimSummary(db, effective, row.episodeId, result.matched_node_ref,
            mentions.filter((mention) => mention.episodeId === row.episodeId),
            new Set(evidence.map((item) => rawMemorySourceId(item.source_ref))))
          : null;
        const summary = interpreted || evidence[0]?.excerpt;
        return summary ? { ...result, summary, evidence, interpretations: resultInterpretations(db, effective, evidence), current_state_requires_verification: true, requirements: resultRequirements(db, effective, evidence) } : null;
      });
      results.push(minimum);
      resultOffsets.push(fullOffsets[index]!);
      if (memoryRecallNativeEnvelopeBytes(build(budgetTrimmed)) > V2_RECALL_ENVELOPE_BYTES) {
        results.pop();
        resultOffsets.pop();
        budgetTrimmed = true;
        if (results.length) break;
      }
    }
    for (let index = 0; index < results.length; index += 1) {
      const minimum = results[index]!;
      results[index] = fullResults.find((item) => item.episode_ref === minimum.episode_ref)!;
      if (memoryRecallNativeEnvelopeBytes(build(budgetTrimmed)) > V2_RECALL_ENVELOPE_BYTES) results[index] = minimum;
    }
    const response = build(budgetTrimmed);
    if (!response.next_cursor) inventories.delete(cursor.key);
    return response;
  } finally {
    if (db.inTransaction) db.exec("ROLLBACK");
    db.close();
  }
}

function minimumRecallBundle(
  result: V2RecallResultItem,
  rebind: (evidence: V2RecallResultItem["evidence"]) => V2RecallResultItem | null,
): V2RecallResultItem {
  let minimum = result;
  const requirementKey = (item: V2RecallResultItem) => JSON.stringify(
    (item.requirements ?? []).map(({ source_refs: _refs, ...requirement }) => requirement)
      .sort((a, b) => a.node_ref.localeCompare(b.node_ref)),
  );
  for (let index = result.evidence.length - 1; index > 0; index -= 1) {
    const candidate = rebind(minimum.evidence.filter((_, current) => current !== index));
    if (candidate && candidate.summary === result.summary &&
      candidate.matched_node_ref === result.matched_node_ref &&
      requirementKey(candidate) === requirementKey(result)) minimum = candidate;
  }
  // A constraint's source excerpt is kept intact. For ordinary facts the full
  // statement stays in summary; only the supplementary source preview shrinks.
  if (!minimum.requirements?.length) {
    minimum = Object.create(Object.getPrototypeOf(minimum), Object.getOwnPropertyDescriptors(minimum)) as V2RecallResultItem;
    minimum.evidence = minimum.evidence.map((item) => ({ ...item,
      excerpt: truncateRecallExcerpt(item.excerpt, V2_RECALL_COMPACT_EXCERPT_GRAPHEMES),
    }));
  }
  return minimum;
}

function memoryRecallNativeEnvelopeBytes(result: RecallMemoryResult): number {
  return Buffer.byteLength(
    JSON.stringify({ ok: true, output: { ok: true, ...result } }),
    "utf8",
  );
}
function encodeRecallCursor(key: string, offset: number): string {
  return Buffer.from(
    JSON.stringify({
      schema: "butler.recall-cursor.v2",
      key,
      offset,
    }),
    "utf8",
  ).toString("base64url");
}

function recallReadArgs(input: RecallMemoryInput, sourceRef: string) {
  return {
    scope: input.scope,
    source_ref: sourceRef,
    max_chars: 12_000,
    ...(input.sessionIds.length ? { session_ids: [...input.sessionIds] } : {}),
    ...(input.projectFilter !== "any"
      ? { project_filter: input.projectFilter }
      : {}),
    ...(input.projectIds.length ? { project_ids: [...input.projectIds] } : {}),
    ...(input.includeInternal ? { include_internal: true } : {}),
  };
}

function v2RecallCursorPage(
  input: RecallMemoryInput,
  generationId: string,
  graphRevision: string,
  currentCandidates: RecallMemoryResult["results"],
  inventories: V2RecallInventoryCache,
): {
  episodeIds: string[];
  nextCursor: string | null;
  key: string;
  candidateCount: number;
} {
  const now = Date.now();
  for (const [key, value] of inventories) {
    if (now - value.createdAt > V2_RECALL_CURSOR_TTL_MS) {
      inventories.delete(key);
    }
  }
  const argumentHash = v2RecallArgumentHash(input);
  const key = sha256(
    `${argumentHash}:${generationId}:${graphRevision}:${now}:${Math.random()}`,
  );
  const inventory: V2RecallInventory = {
    createdAt: now,
    argumentHash,
    generationId,
    graphRevision,
    asOf: input.asOf,
    candidates: currentCandidates.slice(0, 128).map(({
      episode_ref,
      revision,
      channels,
      matched_node_ref,
      association_path,
      qualifications,
    }) => ({
      episode_ref,
      revision,
      channels,
      matched_node_ref,
      association_path,
      qualifications,
    })),
  };
  inventories.set(key, inventory);
  while (inventories.size > V2_RECALL_CURSOR_MAX_ENTRIES) {
    inventories.delete(inventories.keys().next().value!);
  }
  const episodeIds = inventory.candidates.slice(0, input.limit)
    .map((item) => item.episode_ref);
  const nextCursor = episodeIds.length < inventory.candidates.length
    ? encodeRecallCursor(key, episodeIds.length)
    : null;
  return {
    episodeIds,
    nextCursor,
    key,
    candidateCount: inventory.candidates.length,
  };
}

function loadEligibleMentionsForEpisodes(
  db: Database,
  input: RecallMemoryInput,
  episodeIds: string[],
): RecallMention[] {
  if (!episodeIds.length) return [];
  const event = eventEpisodeEligibility(input, "m.episode_id");
  const validity = claimEligibility(input);
  return db.query<
    {
      node_id: string;
      source_id: string;
      episode_id: string;
      revision: string;
    },
    any
  >(`
    SELECT DISTINCT m.node_id,m.source_id,m.episode_id,m.revision FROM memory_evidence m
    JOIN memory_nodes e ON e.id=m.node_id JOIN memory_chunk_sources s ON s.source_id=m.source_id
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE m.episode_id IN (${
    episodeIds.map(() => "?").join(",")
  }) AND ${validity.sql} AND ${
    scopeSql(input)
  } ${event.sql} ORDER BY m.episode_id,m.source_id
  `).all(...episodeIds, ...validity.args, ...scopeArgs(input), ...event.args)
    .map((row) => ({
      nodeId: row.node_id,
      sourceId: row.source_id,
      episodeId: row.episode_id,
      revision: row.revision,
    }));
}

function loadEligibleEpisodeSources(
  db: Database,
  input: RecallMemoryInput,
  episodeIds: string[],
): RecallMention[] {
  if (!episodeIds.length) return [];
  const event = eventEpisodeEligibility(input, "s.episode_id");
  return db.query<
    { source_id: string; episode_id: string; revision: string },
    any
  >(`
    SELECT s.source_id,s.episode_id,s.revision FROM memory_source_leaves s
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE s.episode_id IN (${episodeIds.map(() => "?").join(",")}) AND ${
    scopeSql(input)
  } ${event.sql}
    ORDER BY s.observed_at DESC,s.source_id
  `).all(...episodeIds, ...scopeArgs(input), ...event.args).map((row) => ({
    nodeId: row.episode_id,
    sourceId: row.source_id,
    episodeId: row.episode_id,
    revision: row.revision,
    relation: "supports",
  }));
}

function normalizeV2RecallInput(request: RecallMemoryInput): RecallMemoryInput {
  if (
    !request.runtime?.sessionId.trim() || !request.runtime.turnId.trim() ||
    !request.runtime.currentUserMessage.trim() ||
    !request.runtime.nativeOperationId.trim()
  ) {
    throw new Error("invalid_runtime_binding");
  }
  if (!request.cue.trim() || graphemeCount(request.cue) > 2_048) {
    throw new Error("invalid_arguments");
  }
  if (
    !Number.isSafeInteger(request.limit) || request.limit < 1 ||
    request.limit > 20
  ) throw new Error("invalid_arguments");
  if (
    (request.seedPhrases?.length ?? 0) > 16 ||
    request.seedPhrases?.some((value) => !value || graphemeCount(value) > 512)
  ) throw new Error("invalid_arguments");
  if (
    (request.vectorQueries?.length ?? 0) > 4 ||
    request.vectorQueries?.some((value) =>
      !value || graphemeCount(value) > 2_048,
    )
  ) throw new Error("invalid_arguments");
  if (request.sessionIds.length > 32 || request.projectIds.length > 16) {
    throw new Error("invalid_arguments");
  }
  if (
    (request.projectFilter === "selected") !== (request.projectIds.length > 0)
  ) throw new Error("invalid_arguments");
  if (
    request.scope === "current_project" && request.runtime.projectId === null
  ) throw new Error("invalid_scope");
  if (request.scope === "current_session" && !request.runtime.sessionId) {
    throw new Error("invalid_scope");
  }
  if (
    !isOffsetIso(request.asOf) ||
    request.time &&
      (!isOffsetIso(request.time.from) || !isOffsetIso(request.time.to) ||
        Date.parse(request.time.from) >= Date.parse(request.time.to))
  ) {
    throw new Error("invalid_arguments");
  }
  return {
    ...request,
    asOf: new Date(request.asOf).toISOString(),
    ...(request.time
      ? {
        time: {
          ...request.time,
          from: new Date(request.time.from).toISOString(),
          to: new Date(request.time.to).toISOString(),
        },
      }
      : {}),
  };
}

function isOffsetIso(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u
    .test(value) && Number.isFinite(Date.parse(value));
}

function loadEligibleAdjacency(
  db: Database,
  input: RecallMemoryInput,
  nodeId: string,
  limit: number,
  offset: number,
) {
  const requested = Math.max(1, Math.min(256, limit));
  const queryLimit = requested + 1;
  const claimValidity = claimEligibility(input, "claim");
  const rows = db.query<
    {
      edge_id: string;
      source_node_id: string;
      target_node_id: string;
      rel_type: string;
      claim_node_id: string | null;
      support: number;
    },
    any
  >(`
    SELECT e.edge_id,e.source_node_id,e.target_node_id,e.rel_type,e.claim_node_id,COUNT(DISTINCT s.episode_id) support
    FROM edges e JOIN edge_evidence ee ON ee.edge_id=e.edge_id
    LEFT JOIN memory_nodes claim ON claim.id=e.claim_node_id
    JOIN memory_chunk_sources s ON s.source_id=ee.chunk_source_id
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE (e.source_node_id=? OR e.target_node_id=?) AND e.status='active'
      AND e.rel_type IN ('related_to','depends_on','likes','dislikes','decided','has_subject','has_object','condition_member','belongs_to','co_occurred','identity_match','same_claim')
      AND (e.valid_from IS NULL OR julianday(e.valid_from)<=julianday(?))
      AND (e.valid_to IS NULL OR julianday(e.valid_to)>julianday(?))
      AND (e.claim_node_id IS NULL OR ${claimValidity.sql}) AND ${
    scopeSql(input)
  }
      AND NOT EXISTS(SELECT 1 FROM edge_evidence dependency
        LEFT JOIN memory_chunk_sources ds ON ds.source_id=dependency.chunk_source_id
        LEFT JOIN memory_chunks dc ON dc.memory_chunk_id=ds.episode_id AND dc.current_revision=ds.revision
        WHERE dependency.edge_id=e.edge_id AND (dc.memory_chunk_id IS NULL OR NOT (${scopeSql(input, undefined, "ds", "dc")})))
    GROUP BY e.edge_id ORDER BY
      CASE WHEN e.rel_type IN ('belongs_to','co_occurred','identity_match','same_claim') THEN 1 ELSE 0 END,
      support DESC,e.rel_type,
      CASE WHEN e.source_node_id=? THEN e.target_node_id ELSE e.source_node_id END,e.edge_id
    LIMIT ${queryLimit} OFFSET ${Math.max(0, Math.trunc(offset))}
  `).all(
    nodeId,
    nodeId,
    input.asOf,
    input.asOf,
    ...claimValidity.args,
    ...scopeArgs(input),
    ...scopeArgs(input),
    nodeId,
  );
  return {
    edges: rows.slice(0, requested).map((row) => ({
      edgeId: row.edge_id,
      sourceNodeId: row.source_node_id,
      targetNodeId: row.target_node_id,
      relation: row.rel_type,
      claimNodeId: row.claim_node_id,
      support: Number(row.support),
    })),
    truncated: rows.length > requested,
  };
}

function filterCurrentVectorMatches(
  db: Database,
  input: RecallMemoryInput,
  generation: MemoryGenerationHandle,
  vector: GenerationVectorMatches,
): GenerationVectorMatches & { partial: boolean } {
  const currentRows = filterCurrentGenerationVectorMatches(
    db,
    generation,
    vector,
    {
      scope: input.scope,
      projectFilter: input.projectFilter,
      projectIds: input.projectIds,
      runtimeProjectId: input.runtime.projectId,
      runtimeSessionId: input.runtime.sessionId,
      sessionIds: input.sessionIds,
      asOf: input.asOf,
      time: input.time,
      includeInternal: input.includeInternal,
      eventEpisodeEligibility: (episodeExpression) =>
        eventEpisodeEligibility(input, episodeExpression),
    },
  );
  let partial = currentRows.partial ||
    vectorProjectionIncomplete(db, input, generation.generationId);
  const episodes = currentRows.episodes.filter((match) => {
    const current = vectorEventEligible(db, input, match.ownerId);
    if (!current) partial = true;
    return current;
  }).map((match, index) => ({ ...match, rank: index + 1 }));
  const nodes = currentRows.nodes.filter((match) => {
    const current = typeof match.sourceEpisodeId === "string";
    if (!current) partial = true;
    return current;
  }).map((match, index) => ({ ...match, rank: index + 1 }));
  return { nodes, episodes, diagnostics: currentRows.diagnostics, partial };
}

function vectorEventEligible(
  db: Database,
  input: RecallMemoryInput,
  episodeId?: string,
): boolean {
  if (input.time?.basis !== "event") return true;
  const clauses = [
    "e.type IN ('preference','goal','constraint','decision','memory_atom')",
    "julianday((SELECT valid_from FROM memory_claims WHERE node_id=e.id))<julianday(?)",
    "julianday(COALESCE((SELECT valid_to FROM memory_claims WHERE node_id=e.id),?))>julianday(?)",
  ];
  const args: Array<string | null> = [
    input.time.to,
    input.time.to,
    input.time.from,
  ];
  if (episodeId) {
    clauses.push("m.episode_id=?");
    args.push(episodeId);
  }
  return Boolean(
    db.query<{ found: number }, Array<string | null>>(`
    SELECT 1 found FROM memory_evidence m JOIN memory_nodes e ON e.id=m.node_id
    JOIN memory_chunk_sources s ON s.source_id=m.source_id
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE ${clauses.join(" AND ")} AND ${scopeSql(input)} LIMIT 1
  `).get(...args, ...scopeArgs(input)),
  );
}

function vectorProjectionIncomplete(
  db: Database,
  input: RecallMemoryInput,
  generationId: string,
): boolean {
  return Number(
    db.query<{ count: number }, any>(`
    SELECT COUNT(DISTINCT u.unit_id) count FROM memory_vector_units u
    JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
    JOIN memory_chunk_sources s ON s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision
    WHERE j.generation=? AND u.state!='complete' AND ${scopeSql(input)}
  `).get(generationId, ...scopeArgs(input))?.count ?? 0,
  ) > 0;
}

function graphProjectionCoverage(
  db: Database,
  input: RecallMemoryInput,
  generation: MemoryGenerationHandle,
  deadlineAt: number,
): { pending: boolean; codes: string[] } {
  const registeredIncomplete = Number(
    db.query<{ count: number }, any>(`
    SELECT COUNT(DISTINCT j.job_id) count FROM memory_projection_jobs j
    JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
    JOIN memory_chunk_sources s ON s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision
    WHERE json_extract(j.semantic_graph_state,'$.state')!='complete' AND ${
      scopeSql(input)
    }
  `).get(...scopeArgs(input))?.count ?? 0,
  ) > 0;
  const inventory = canonicalConversationProjectionInventory({
    butlerData: generation.sourceRoot,
    canonicalDbPath: generation.canonicalSnapshotPath ?? undefined,
    asOf: input.asOf,
    deadlineAt,
    scope: input.scope,
    currentSessionId: input.runtime.sessionId,
    currentProjectId: input.runtime.projectId,
    sessionIds: input.sessionIds,
    projectFilter: input.projectFilter,
    projectIds: input.projectIds,
    time: input.time,
  });
  const missing = inventory.entries.some((entry) =>
    !db.query<{ found: number }, [string, string]>(`
    SELECT 1 found FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision
    WHERE c.memory_chunk_id=? AND c.current_revision=? AND json_extract(j.semantic_graph_state,'$.state')='complete' LIMIT 1
  `).get(entry.episodeId, entry.revision),
  );
  const codes = [
    ...(registeredIncomplete || missing ? ["ingestion_pending"] : []),
    ...(inventory.partial ? ["ingestion_inventory_partial"] : []),
  ];
  return {
    pending: registeredIncomplete || missing || inventory.partial,
    codes,
  };
}

function loadEligibleMentions(
  db: Database,
  input: RecallMemoryInput,
  nodeIds: string[],
): RecallMention[] {
  if (!nodeIds.length) return [];
  const event = eventEpisodeEligibility(input, "m.episode_id");
  const validity = claimEligibility(input);
  return db.query<
    {
      node_id: string;
      source_id: string;
      episode_id: string;
      revision: string;
    },
    any
  >(`
    SELECT DISTINCT m.node_id,m.source_id,m.episode_id,m.revision FROM memory_evidence m
    JOIN memory_nodes e ON e.id=m.node_id JOIN memory_chunk_sources s ON s.source_id=m.source_id
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE m.node_id IN (${
    nodeIds.map(() => "?").join(",")
  }) AND ${validity.sql} AND ${scopeSql(input)} ${event.sql}
    ORDER BY m.episode_id,m.source_id
  `).all(...nodeIds, ...validity.args, ...scopeArgs(input), ...event.args).map((
    row,
  ) => ({
    nodeId: row.node_id,
    sourceId: row.source_id,
    episodeId: row.episode_id,
    revision: row.revision,
  }));
}

function eventEpisodeEligibility(
  input: RecallMemoryInput,
  episodeExpression: string,
): { sql: string; args: Array<string | null> } {
  if (input.time?.basis !== "event") return { sql: "", args: [] };
  return {
    sql: `AND EXISTS(
      SELECT 1 FROM memory_evidence time_mention
      JOIN memory_nodes time_entity ON time_entity.id=time_mention.node_id
      JOIN memory_chunk_sources time_source ON time_source.source_id=time_mention.source_id
      JOIN memory_chunks time_chunk ON time_chunk.memory_chunk_id=time_source.episode_id AND time_chunk.current_revision=time_source.revision
      WHERE time_mention.episode_id=${episodeExpression}
        AND time_entity.type IN ('preference','goal','constraint','decision','memory_atom')
        AND julianday((SELECT valid_from FROM memory_claims WHERE node_id=time_entity.id))<julianday(?)
        AND julianday(COALESCE((SELECT valid_to FROM memory_claims WHERE node_id=time_entity.id),?))>julianday(?)
        AND ${scopeSql(input, undefined, "time_source", "time_chunk")}
    )`,
    args: [input.time.to, input.time.to, input.time.from, ...scopeArgs(input)],
  };
}

function episodeRows(
  db: Database,
  input: RecallMemoryInput,
  episodeIds: string[],
  rawEpisodes = new Set<string>(),
) {
  if (!episodeIds.length) return [];
  const validity = claimEligibility(input, "claim", "node_id");
  const rows = db.query<
    {
      episodeId: string;
      revision: string;
      summary: string;
      hasClaims: number;
      conversationAt: string | null;
      sessionId: string;
      turnId: string;
      projectId: string | null;
      eventAt: string | null;
      salience: "high" | "normal" | "unspecified";
      explicitPriority: number;
      supportCount: number;
      halfLifeDays: number;
    },
    any
  >(`
    WITH eligible_sources AS (
      SELECT s.* FROM memory_chunk_sources s
      JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
      WHERE c.memory_chunk_id IN (${episodeIds.map(() => "?").join(",")}) AND ${
    scopeSql(input)
  }
    ), all_claims AS (
      SELECT m.episode_id,e.id node_id,e.type,m.source_id FROM memory_evidence m
      JOIN eligible_sources source ON source.source_id=m.source_id
      JOIN memory_nodes e ON e.id=m.node_id
      WHERE e.type IN ('preference','goal','constraint','decision','memory_atom')
    ), eligible_claims AS (
      SELECT claim.* FROM all_claims claim WHERE ${validity.sql}
    )
    SELECT c.memory_chunk_id episodeId,c.current_revision revision,c.summary summary,
      CASE WHEN COUNT(DISTINCT all_claims.node_id)>0 THEN 1 ELSE 0 END hasClaims,
      strftime('%Y-%m-%dT%H:%M:%fZ',MAX(julianday(source.observed_at))) conversationAt,
      c.conversation_session_id sessionId,c.conversation_turn_id turnId,
      c.project_id projectId,
      MAX((SELECT valid_from FROM memory_claims WHERE node_id=eligible_claims.node_id)) eventAt,
      CASE WHEN MAX(CASE (SELECT salience FROM memory_claims WHERE node_id=eligible_claims.node_id) WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END)=2 THEN 'high'
        WHEN MAX(CASE (SELECT salience FROM memory_claims WHERE node_id=eligible_claims.node_id) WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END)=1 THEN 'normal' ELSE 'unspecified' END salience,
      0 explicitPriority,
      CASE WHEN MAX(CASE WHEN eligible_claims.type='goal' THEN 1 ELSE 0 END)=1 THEN 7 ELSE 30 END halfLifeDays,
      0 supportCount
    FROM memory_chunks c JOIN eligible_sources source ON source.episode_id=c.memory_chunk_id
    LEFT JOIN all_claims ON all_claims.episode_id=c.memory_chunk_id
    LEFT JOIN eligible_claims ON eligible_claims.episode_id=c.memory_chunk_id
    GROUP BY c.memory_chunk_id
    HAVING COUNT(DISTINCT all_claims.node_id)=0 OR COUNT(DISTINCT eligible_claims.node_id)>0 OR c.memory_chunk_id IN (${[...rawEpisodes].map(() => "?").join(",") || "NULL"})
    ORDER BY c.memory_chunk_id
  `).all(...episodeIds, ...scopeArgs(input), ...validity.args, ...rawEpisodes);
  const requestedHistoricalEvent = input.time?.basis === "event" &&
    Date.parse(input.time.to) <= Date.parse(input.asOf);
  return rows.map((row) => ({
    ...row,
    historical: requestedHistoricalEvent ||
      episodeHasHistoricalClaim(db, input, row.episodeId),
  }));
}

function matchedClaimSummary(
  db: Database,
  input: RecallMemoryInput,
  episodeId: string,
  matchedNodeId: string | null,
  mentions: RecallMention[],
  survivingSourceIds: Set<string>,
): string | null {
  if (!matchedNodeId) return null;
  const matchedSourceIds = [
    ...new Set(
      mentions
        .filter((mention) =>
          mention.nodeId === matchedNodeId &&
          survivingSourceIds.has(mention.sourceId),
        )
        .map((mention) => mention.sourceId),
    ),
  ];
  if (!matchedSourceIds.length) return null;
  const matchedIsClaim = [
    "preference",
    "goal",
    "constraint",
    "decision",
    "memory_atom",
  ].includes(nodeType(db, matchedNodeId) ?? "");
  const validity = claimEligibility(input);
  const row = db.query<{ statement: unknown }, any>(`
    SELECT (SELECT statement FROM memory_claims WHERE node_id=e.id) statement FROM memory_evidence m
    JOIN memory_nodes e ON e.id=m.node_id JOIN memory_chunk_sources s ON s.source_id=m.source_id
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE m.episode_id=? AND m.source_id IN (${
    matchedSourceIds.map(() => "?").join(",")
  })
      AND NOT EXISTS(SELECT 1 FROM memory_evidence dependency WHERE dependency.node_id=e.id AND dependency.source_id NOT IN (${[...survivingSourceIds].map(() => "?").join(",")}))
      AND e.type IN ('preference','goal','constraint','decision','memory_atom')
      ${matchedIsClaim ? "AND e.id=?" : ""} AND ${validity.sql} AND ${
    scopeSql(input)
  }
    ORDER BY CASE WHEN e.id=? THEN 0 ELSE 1 END,m.source_id,e.id LIMIT 1
  `).get(
    episodeId,
    ...matchedSourceIds,
    ...survivingSourceIds,
    ...(matchedIsClaim ? [matchedNodeId] : []),
    ...validity.args,
    ...scopeArgs(input),
    matchedNodeId,
  );
  return typeof row?.statement === "string" && row.statement.length > 0
    ? row.statement
    : null;
}

function episodeHasHistoricalClaim(
  db: Database,
  input: RecallMemoryInput,
  episodeId: string,
): boolean {
  const now = new Date().toISOString();
  if (Date.parse(input.asOf) > Date.parse(now)) return false;
  const selected = claimEligibility(input, "selected");
  const current = claimEligibility(
    { ...input, asOf: now, time: undefined },
    "selected",
  );
  return Boolean(
    db.query<{ found: number }, any>(`
    SELECT 1 found FROM memory_evidence m JOIN memory_nodes selected ON selected.id=m.node_id
    JOIN memory_chunk_sources s ON s.source_id=m.source_id
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE m.episode_id=? AND selected.type IN ('preference','goal','constraint','decision','memory_atom')
      AND ${selected.sql} AND NOT (${current.sql}) AND ${
      scopeSql(input)
    } LIMIT 1
  `).get(episodeId, ...selected.args, ...current.args, ...scopeArgs(input)),
  );
}

function supportCountForEpisode(
  db: Database,
  input: RecallMemoryInput,
  episodeId: string,
): number {
  return Number(
    db.query<{ count: number }, any>(`
    SELECT COUNT(DISTINCT s.episode_id) count FROM memory_evidence candidate
    JOIN memory_chunk_sources candidate_source ON candidate_source.source_id=candidate.source_id
    JOIN memory_chunks candidate_chunk ON candidate_chunk.memory_chunk_id=candidate_source.episode_id AND candidate_chunk.current_revision=candidate_source.revision
    JOIN edges e ON e.claim_node_id=candidate.node_id JOIN edge_evidence ee ON ee.edge_id=e.edge_id
    JOIN memory_chunk_sources s ON s.source_id=ee.chunk_source_id JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE candidate.episode_id=? AND e.status='active'
      AND (e.valid_from IS NULL OR julianday(e.valid_from)<=julianday(?))
      AND (e.valid_to IS NULL OR julianday(e.valid_to)>julianday(?))
      AND ${
      scopeSql(input, undefined, "candidate_source", "candidate_chunk")
    } AND ${scopeSql(input)}
  `).get(
        episodeId,
        input.asOf,
        input.asOf,
        ...scopeArgs(input),
        ...scopeArgs(input),
      )?.count ?? 0,
  );
}

function episodeRelationshipState(
  db: Database,
  input: RecallMemoryInput,
  episodeId: string,
): {
  superseded: boolean;
  explicitPriority: boolean;
  explicitRuleSourceIds: Set<string>;
  prioritySourceIds: Set<string>;
  qualifications: string[];
} {
  const rows = selectEpisodeRelationshipRows(db, input, episodeId);
  const superseded = rows.some((row) =>
    row.relation === "supersedes" &&
    row.target_node_id === row.candidate_node_id,
  );
  const currentCorrection = rows.some((row) =>
    row.relation === "supersedes" &&
    row.source_node_id === row.candidate_node_id,
  );
  const conflicting = rows.some((row) => row.relation === "contradicts");
  const historical = !superseded &&
    hasLaterCurrentSupersession(db, input, episodeId);
  const explicitRuleSourceIds = currentExplicitRuleSourceIds(
    db,
    input,
    episodeId,
  );
  const prioritySourceIds = new Set(
    rows.filter((row) =>
      row.relation === "contradicts" ||
      row.source_node_id === row.candidate_node_id,
    ).map((row) => row.evidence_source_id),
  );
  for (const sourceId of explicitRuleSourceIds) prioritySourceIds.add(sourceId);
  return {
    superseded,
    explicitPriority: currentCorrection || explicitRuleSourceIds.length > 0,
    explicitRuleSourceIds: new Set(explicitRuleSourceIds),
    prioritySourceIds,
    qualifications: [
      ...(historical ? ["historical"] : []),
      ...(superseded ? ["superseded"] : []),
      ...(conflicting ? ["conflicting"] : []),
    ],
  };
}

function currentExplicitRuleSourceIds(
  db: Database,
  input: RecallMemoryInput,
  episodeId: string,
): string[] {
  const validity = claimEligibility(input);
  return db.query<{ source_id: string }, any>(`
    SELECT DISTINCT m.source_id FROM memory_evidence m JOIN memory_nodes e ON e.id=m.node_id
    JOIN memory_chunk_sources s ON s.source_id=m.source_id
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE m.episode_id=? AND e.type='constraint'
      AND (SELECT speech_act FROM memory_claims WHERE node_id=e.id)='assertion'
      AND (SELECT basis FROM memory_claims WHERE node_id=e.id)='user_statement'
      AND ((s.source_kind='conversation' AND s.role='user' AND s.origin_kind='user_input')
        OR (s.source_kind='explicit_record' AND s.role='explicit'))
      AND s.basis='user_statement'
      AND ${validity.sql} AND ${scopeSql(input)} ORDER BY m.source_id
  `).all(episodeId, ...validity.args, ...scopeArgs(input)).map((row) =>
    row.source_id,
  );
}

function hasLaterCurrentSupersession(
  db: Database,
  input: RecallMemoryInput,
  episodeId: string,
): boolean {
  if (input.time?.basis === "event") {
    return Boolean(
      db.query<{ found: number }, any>(`
      SELECT 1 found FROM memory_evidence candidate
      JOIN memory_chunk_sources candidate_source ON candidate_source.source_id=candidate.source_id
      JOIN memory_chunks candidate_chunk ON candidate_chunk.memory_chunk_id=candidate_source.episode_id AND candidate_chunk.current_revision=candidate_source.revision
      JOIN edges e ON e.target_node_id=candidate.node_id AND e.rel_type='supersedes' AND e.status='active'
      JOIN edge_evidence ee ON ee.edge_id=e.edge_id
      JOIN memory_chunk_sources correction_source ON correction_source.source_id=ee.chunk_source_id
      JOIN memory_chunks correction_chunk ON correction_chunk.memory_chunk_id=correction_source.episode_id AND correction_chunk.current_revision=correction_source.revision
      WHERE candidate.episode_id=? AND ${
        scopeSql(input, undefined, "candidate_source", "candidate_chunk")
      }
        AND ${
        scopeSql(input, undefined, "correction_source", "correction_chunk")
      }
        AND julianday(COALESCE(e.valid_from,correction_source.observed_at))>julianday(?)
        AND (e.valid_to IS NULL OR julianday(e.valid_to)>julianday(COALESCE(e.valid_from,correction_source.observed_at))) LIMIT 1
    `).get(
          episodeId,
          ...scopeArgs(input),
          ...scopeArgs(input),
          input.time.from,
        ),
    );
  }
  const currentInput: RecallMemoryInput = {
    ...input,
    asOf: new Date().toISOString(),
    time: undefined,
  };
  return Boolean(
    db.query<{ found: number }, any>(`
    SELECT 1 found FROM memory_evidence candidate
    JOIN memory_chunk_sources candidate_source ON candidate_source.source_id=candidate.source_id
    JOIN memory_chunks candidate_chunk ON candidate_chunk.memory_chunk_id=candidate_source.episode_id AND candidate_chunk.current_revision=candidate_source.revision
    JOIN edges e ON e.target_node_id=candidate.node_id AND e.rel_type='supersedes' AND e.status='active'
    JOIN edge_evidence ee ON ee.edge_id=e.edge_id
    JOIN memory_chunk_sources correction_source ON correction_source.source_id=ee.chunk_source_id
    JOIN memory_chunks correction_chunk ON correction_chunk.memory_chunk_id=correction_source.episode_id AND correction_chunk.current_revision=correction_source.revision
    WHERE candidate.episode_id=? AND ${
      scopeSql(input, undefined, "candidate_source", "candidate_chunk")
    }
      AND ${
      scopeSql(currentInput, undefined, "correction_source", "correction_chunk")
    }
      AND julianday(correction_source.observed_at)>julianday(?)
      AND (e.valid_from IS NULL OR julianday(e.valid_from)<=julianday(?))
      AND (e.valid_to IS NULL OR julianday(e.valid_to)>julianday(?)) LIMIT 1
  `).get(
        episodeId,
        ...scopeArgs(input),
        ...scopeArgs(currentInput),
        input.asOf,
        currentInput.asOf,
        currentInput.asOf,
      ),
  );
}

function nodeType(db: Database, nodeId: string): string | null {
  return db.query<{ type: string }, [string]>(
    "SELECT type FROM memory_nodes WHERE id=?",
  ).get(nodeId)?.type ?? null;
}

function rankedIds(scores: Map<string, number>): string[] {
  return [...scores].filter(([, score]) => score > 0).sort((a, b) =>
    b[1] - a[1] || Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])),
  )
    .slice(0, 128).map(([episodeId]) => episodeId);
}

function rankMap(values: string[]): Map<string, number> {
  return new Map(values.map((value, index) => [value, index + 1]));
}

function recordV2CandidateRankingMetrics(input: {
  input: RecallMemoryInput;
  generationId: string;
  ranked: Array<
    {
      episodeId: string;
      score: number;
      graphRank?: number;
      lexicalRank?: number;
      vectorRank?: number;
      contextRank?: number;
    }
  >;
  graphScores: Map<string, number>;
  lexicalScores: Map<string, number>;
  contextScores: Map<string, number>;
  vectorMatches: Array<{ ownerId: string; distance: number; rank: number }>;
  graphRanks: Map<string, number>;
  lexicalRanks: Map<string, number>;
  contextRanks: Map<string, number>;
  executedChannels: {
    graph: boolean;
    vector: boolean;
    lexical: boolean;
    context: boolean;
  };
}): void {
  const vectorDistances = new Map(
    input.vectorMatches.map((match) => [match.ownerId, match.distance]),
  );
  const vectorRanks = new Map(
    input.vectorMatches.map((match) => [match.ownerId, match.rank]),
  );
  input.ranked.forEach((episode, index) =>
    recordOperationalMetric({
      category: "memory",
      name: "recall_v2_ranking",
      status: "ok",
      value: episode.score,
      unit: "score",
      dimensions: {
        native_operation_sha256: sha256(input.input.runtime.nativeOperationId),
        cue_sha256: sha256(input.input.cue),
        generation_sha256: sha256(input.generationId),
        episode_sha256: sha256(episode.episodeId),
        ranking_stage: "candidate",
        candidate_rank: index + 1,
        candidate_score: episode.score,
        g_rank: input.graphRanks.get(episode.episodeId) ?? 0,
        g_score: input.graphScores.get(episode.episodeId) ?? 0,
        v_rank: vectorRanks.get(episode.episodeId) ?? 0,
        v_ann_distance: vectorDistances.get(episode.episodeId),
        l_rank: input.lexicalRanks.get(episode.episodeId) ?? 0,
        l_score: input.lexicalScores.get(episode.episodeId) ?? 0,
        c_rank: input.contextRanks.get(episode.episodeId) ?? 0,
        c_score: input.contextScores.get(episode.episodeId) ?? 0,
        graph_executed: input.executedChannels.graph,
        vector_executed: input.executedChannels.vector,
        lexical_executed: input.executedChannels.lexical,
        context_executed: input.executedChannels.context,
      },
    }, { butlerData: input.input.context.butlerData }),
  );
}

function recordV2Stage(
  input: RecallMemoryInput,
  name: string,
  startedAt: number,
): void {
  recordOperationalMetric({
    category: "memory",
    name,
    status: "ok",
    durationMs: performance.now() - startedAt,
    dimensions: {
      native_operation_sha256: sha256(input.runtime.nativeOperationId),
    },
  }, { butlerData: input.context.butlerData });
}

function recordV2ReturnedRankingMetrics(input: {
  input: RecallMemoryInput;
  generationId: string;
  results: RecallMemoryResult["results"];
  candidateRanks: Map<string, number>;
  executedChannels: {
    graph: boolean;
    vector: boolean;
    lexical: boolean;
    context: boolean;
  };
}): void {
  input.results.forEach((result, index) =>
    recordOperationalMetric({
      category: "memory",
      name: "recall_v2_ranking",
      status: "ok",
      value: index + 1,
      unit: "rank",
      dimensions: {
        native_operation_sha256: sha256(input.input.runtime.nativeOperationId),
        cue_sha256: sha256(input.input.cue),
        generation_sha256: sha256(input.generationId),
        episode_sha256: sha256(result.episode_ref),
        ranking_stage: "returned",
        candidate_rank: input.candidateRanks.get(result.episode_ref) ?? 0,
        returned_rank: index + 1,
        graph_executed: input.executedChannels.graph,
        vector_executed: input.executedChannels.vector,
        lexical_executed: input.executedChannels.lexical,
        context_executed: input.executedChannels.context,
      },
    }, { butlerData: input.input.context.butlerData }),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareEvidenceHandles(
  a: { basis: string; observed_at: string; source_id: string } | undefined,
  b: { basis: string; observed_at: string; source_id: string } | undefined,
  prioritySourceIds: Set<string> = new Set(),
): number {
  const priority = (basis: string | undefined) =>
    basis === "user_statement"
      ? 0
      : basis === "reviewed_task"
      ? 1
      : basis === "assistant_statement"
      ? 2
      : 3;
  return Number(prioritySourceIds.has(b?.source_id ?? "")) -
      Number(prioritySourceIds.has(a?.source_id ?? "")) ||
    priority(a?.basis) - priority(b?.basis) ||
    Date.parse(b?.observed_at ?? "") - Date.parse(a?.observed_at ?? "") ||
    Buffer.compare(
      Buffer.from(a?.source_id ?? ""),
      Buffer.from(b?.source_id ?? ""),
    );
}

function emptyV2Recall(input: RecallMemoryInput, facts: {
  vectorCode: string;
  vectorDiagnostics: string[];
  graphCodes: string[];
  selectionCodes: string[];
  vectorPartial: boolean;
  deadlineHit: boolean;
}): RecallMemoryResult {
  const admitted = input.admittedChannels ?? {
    graph: true,
    lexical: true,
    vector: true,
    context: true,
    explicit: true,
    task: true,
  };
  const vectorRequested = input.includeVector && admitted.vector;
  const vectorPartial = facts.vectorDiagnostics.some((code) =>
    code.includes("_omitted=") || code.endsWith("_vector_bound_reached") ||
    code.startsWith("vector_rows_invalid="),
  );
  const graphExecutionIncomplete = facts.graphCodes.length > 0 ||
    facts.selectionCodes.length > 0 || facts.deadlineHit;
  const vectorExecutionIncomplete = vectorRequested &&
    (facts.vectorCode !== "no_hits" || vectorPartial || facts.vectorPartial);
  const partial = facts.graphCodes.length > 0 || graphExecutionIncomplete ||
    vectorExecutionIncomplete;
  const graphCodes = [
    ...facts.graphCodes,
    ...facts.selectionCodes,
    ...(facts.deadlineHit ? ["operation_deadline"] : []),
  ];
  return {
    status: deriveRecallStatus(
      0,
      partial,
      graphExecutionIncomplete || vectorExecutionIncomplete,
    ),
    results: [],
    coverage: {
      graph: admitted.graph
        ? {
        state: graphCodes.length ? "partial" : "ok",
        candidates: 0,
        codes: [...graphCodes, "no_hits"],
      }
        : { state: "disabled_by_request", candidates: 0, codes: [] },
      vectors: vectorRequested
        ? facts.vectorCode === "no_hits"
          ? {
            state: vectorPartial || facts.vectorPartial ? "partial" : "ok",
            candidates: 0,
            codes: [
              ...facts.vectorDiagnostics,
              ...(facts.vectorPartial ? ["vector_current_rows_missing"] : []),
              "no_hits",
            ],
          }
          : {
            state: "unavailable",
            candidates: 0,
            codes: [facts.vectorCode, ...facts.vectorDiagnostics],
          }
        : { state: "disabled_by_request", candidates: 0, codes: [] },
      source: {
        state: facts.graphCodes.length ? "partial" : "ok",
        candidates: 0,
        codes: [...facts.graphCodes],
      },
    },
    next_cursor: null,
    diagnostics: facts.vectorDiagnostics,
  };
}

function deriveRecallStatus(
  resultCount: number,
  partial: boolean,
  executionIncomplete: boolean,
): RecallMemoryResult["status"] {
  if (resultCount === 0 && executionIncomplete) return "unavailable";
  return partial ? "partial" : "complete";
}

function resultRequirements(db: Database, input: RecallMemoryInput, evidence: RecallMemoryResult["results"][number]["evidence"]): NonNullable<RecallMemoryResult["results"][number]["requirements"]> {
  const ids = evidence.map((item) => rawMemorySourceId(item.source_ref));
  if (!ids.length) return [];
  const validity = claimEligibility(input);
  const rows = db.query<{ id: string; source_id: string }, any>(`
    SELECT DISTINCT e.id,m.source_id FROM memory_nodes e JOIN memory_evidence m ON m.node_id=e.id
    JOIN memory_chunk_sources s ON s.source_id=m.source_id
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
    WHERE m.source_id IN (${ids.map(() => "?").join(",")}) AND (SELECT requirement FROM memory_claims WHERE node_id=e.id) IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM memory_evidence dependency WHERE dependency.node_id=e.id AND dependency.source_id NOT IN (${ids.map(() => "?").join(",")}))
      AND ${validity.sql} AND ${scopeSql(input)}
  `).all(...ids, ...ids, ...validity.args, ...scopeArgs(input));
  const result: NonNullable<RecallMemoryResult["results"][number]["requirements"]> = [];
  for (const row of rows) {
    const properties = readClaim(db, row.id);
    if (!properties?.requirement) continue;
    const ref = evidence.find((item) => rawMemorySourceId(item.source_ref) === row.source_id)!.source_ref;
    const existing = result.find((item) => item.node_ref === row.id);
    if (existing) { if (!existing.source_refs.includes(ref)) existing.source_refs.push(ref); }
    else result.push({ node_ref: row.id, ...properties.requirement, basis: properties.basis, source_refs: [ref] });
  }
  return result;
}
