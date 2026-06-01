import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, join } from "path";
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
  searchVectorEpisodes,
  type VectorEpisodeBackend,
} from "./vector.ts";

export type RecallSource = "hot-cache" | "vector" | "graph" | "explicit" | "hybrid" | "project-memory" | "task-memory";

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
  originalSource?: "hot-cache" | "project-memory" | "task-memory" | "rules" | "graph";
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
const RECALL_SEED_MIN_CHARS = 2;
const RECALL_SEED_MAX_TERMS = 24;
const BM25_IDF_SMOOTHING = 0.5;
// BM25 defaults match Apache Lucene BM25Similarity, which cites Robertson et al.,
// "Okapi at TREC-3"; k1 controls term-frequency saturation, b length normalization.
const BM25_TERM_FREQUENCY_SATURATION_K1 = 1.2;
const BM25_DOCUMENT_LENGTH_NORMALIZATION_B = 0.75;
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
// Protected by recall regression tests; candidates below this level tended to
// be recency/frequency noise rather than usable evidence.
const DEFAULT_MIN_RECALL_SCORE = 0.22;
const DEFAULT_RECALL_CACHE_TTL_MS = 30_000;

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(predicate)
    .map((name) => join(dir, name));
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
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
  return text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}._-]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= RECALL_SEED_MIN_CHARS);
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
  documentFrequency: Map<string, number>;
  averageDocumentLength: number;
  documentCount: number;
}

function buildLexicalStats(candidates: RecallCandidate[], seeds: string[]): LexicalStats {
  const queryTerms = [...new Set(seeds.flatMap((seed) => lexicalTokens(seed)))];
  const documentFrequency = new Map<string, number>();
  let totalDocumentLength = 0;
  for (const candidate of candidates) {
    const documentTokens = lexicalTokens(`${candidate.summary}\n${candidate.text}`);
    const uniqueDocumentTokens = new Set(documentTokens);
    totalDocumentLength += documentTokens.length;
    for (const term of queryTerms) {
      if (uniqueDocumentTokens.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  return {
    queryTerms,
    documentFrequency,
    averageDocumentLength: candidates.length > 0 ? totalDocumentLength / candidates.length : 0,
    documentCount: candidates.length,
  };
}

function idf(term: string, stats: LexicalStats): number {
  const frequency = stats.documentFrequency.get(term) ?? 0;
  if (frequency === 0 || stats.documentCount === 0) return 0;
  return Math.log(
    1 + (stats.documentCount - frequency + BM25_IDF_SMOOTHING) / (frequency + BM25_IDF_SMOOTHING),
  );
}

function lexicalScore(candidate: RecallCandidate, stats: LexicalStats): number {
  if (stats.queryTerms.length === 0 || stats.documentCount === 0) return 0;
  const tokens = lexicalTokens(`${candidate.summary}\n${candidate.text}`);
  if (tokens.length === 0) return 0;
  const frequencies = frequencyMap(tokens);
  const averageLength = stats.averageDocumentLength > 0 ? stats.averageDocumentLength : tokens.length;
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
      ((termFrequency * (BM25_TERM_FREQUENCY_SATURATION_K1 + 1)) / (termFrequency + lengthNormalization));
  }
  if (availableQueryWeight <= 0) return 0;
  return clamp01(score / availableQueryWeight);
}

function semanticScore(candidate: RecallCandidate): number {
  if (candidate.source !== "vector" || typeof candidate.vectorSimilarity !== "number") return 0;
  return clamp01(candidate.vectorSimilarity);
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
  ].flatMap((value) => lexicalTokens(value ?? "")).filter((value, index, values) => values.indexOf(value) === index);
  if (terms.size === 0 && relatedNodeIds.size === 0 && provenanceNeedles.length === 0) return null;
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
  const candidateTerms = new Set(lexicalTokens(`${candidate.summary}\n${candidate.text}`));
  const lexicalContinuity = binaryCosine(evidence.terms, candidateTerms);
  const relatedNodes = candidate.relatedNodes ?? [];
  const graphContinuity = relatedNodes.length === 0
    ? 0
    : relatedNodes.filter((node) => evidence.relatedNodeIds.has(node)).length / relatedNodes.length;
  const provenanceContinuity = evidence.provenanceNeedles.some((needle) =>
    candidate.provenance.some((provenance) => lexicalTokens(provenance).includes(needle)),
  )
    ? 1
    : 0;
  return Math.max(explicit, lexicalContinuity, graphContinuity, provenanceContinuity);
}

function recencyScore(timestamp: number | undefined, now: number): number {
  if (!timestamp) return UNKNOWN_TIMESTAMP_RECENCY_SCORE;
  const ageMs = Math.max(0, now - timestamp * 1000);
  const recencyWindowMs = RECENCY_DECAY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(0, 1 - ageMs / recencyWindowMs);
}

function frequencyScore(value: number | undefined): number {
  return Math.min(1, Math.log1p(value ?? 0) / Math.log1p(FREQUENCY_NORMALIZATION_REFERENCE_COUNT));
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

function activateGraph(corpus: RecallCorpus, seeds: string[]): Map<string, number> {
  const activation = new Map<string, number>();
  const degree = buildDegreeMap(corpus);
  for (const node of corpus.nodes) {
    const name = node.name.toLowerCase();
    const matched = seeds.some((seed) => name.includes(seed) || seed.includes(name));
    if (matched) activation.set(node.id, 1);
  }

  for (let hop = 0; hop < GRAPH_ACTIVATION_HOPS; hop += 1) {
    const next = new Map(activation);
    for (const edge of corpus.edges) {
      const weight = edge.weight ?? 1;
      const cappedWeight = Math.min(GRAPH_EDGE_WEIGHT_CAP, weight);
      const spread = GRAPH_FORWARD_SPREAD_FACTOR * cappedWeight / (1 + (degree.get(edge.sourceId) ?? 0));
      const reverseSpread = GRAPH_REVERSE_SPREAD_FACTOR * cappedWeight / (1 + (degree.get(edge.targetId) ?? 0));
      const sourceActivation = activation.get(edge.sourceId) ?? 0;
      const targetActivation = activation.get(edge.targetId) ?? 0;
      if (sourceActivation > 0) {
        next.set(edge.targetId, Math.max(next.get(edge.targetId) ?? 0, sourceActivation * spread));
      }
      if (targetActivation > 0) {
        next.set(edge.sourceId, Math.max(next.get(edge.sourceId) ?? 0, targetActivation * reverseSpread));
      }
    }
    activation.clear();
    for (const [key, value] of next) activation.set(key, value);
  }
  return activation;
}

function candidateGraphActivation(candidate: RecallCandidate, activation: Map<string, number>): number {
  const nodes = candidate.relatedNodes ?? [];
  if (nodes.length === 0) return 0;
  return Math.max(...nodes.map((node) => activation.get(node) ?? 0), 0);
}

function candidateHubPenalty(candidate: RecallCandidate, degree: Map<string, number>): number {
  const nodes = candidate.relatedNodes ?? [];
  if (nodes.length === 0) return 0;
  return Math.max(
    ...nodes.map((node) =>
      Math.min(
        1,
        Math.max(
          0,
          ((degree.get(node) ?? 0) - HUB_PENALTY_FREE_DEGREE) / HUB_PENALTY_FULL_SCALE,
        ),
      ),
    ),
    0,
  );
}

function candidateConflictPenalty(candidate: RecallCandidate, activeCandidateIds: Set<string>): number {
  return candidate.contradicts?.some((id) => activeCandidateIds.has(id)) ? CONFLICTING_MEMORY_PENALTY : 0;
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

interface ActiveRecallPolicy {
  planned: boolean;
  strategies: RetrievalStrategy[];
  evidenceRequired: RetrievalEvidenceRequirement[];
}

function activeRecallPolicy(policy: RecallEvidencePolicy | undefined): ActiveRecallPolicy {
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

function nonExactEvidenceRequirements(policy: ActiveRecallPolicy): RetrievalEvidenceRequirement[] {
  return policy.evidenceRequired.filter((requirement) => requirement !== "exact_quote");
}

function uniqueStrings<T extends string>(values: T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function hasVectorProvenance(candidate: RecallCandidate): boolean {
  return candidate.source === "vector" && candidate.provenance.some((entry) => entry.startsWith("vector:"));
}

function hasProjectMemoryProvenance(candidate: RecallCandidate): boolean {
  return candidate.source === "project-memory" || candidate.originalSource === "project-memory";
}

function hasTaskContinuityProvenance(candidate: RecallCandidate): boolean {
  return candidate.provenance.some((entry) => entry.startsWith("task:") || entry.includes(":task:"));
}

function hasRecentTurnProvenance(candidate: RecallCandidate): boolean {
  return candidate.source === "hot-cache" ||
    candidate.provenance.some((entry) => entry.startsWith("session:") || entry.startsWith("turn:"));
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
      ? Math.max(signals.lexical, signals.contextual, signals.graph, signals.explicit)
      : 0;
  }
  if (requirement === "graph_relation_hit") {
    return candidate.relatedNodes?.length ? signals.graph : 0;
  }
  if (requirement === "explicit_rule_hit") {
    return candidate.source === "explicit" || candidate.originalSource === "rules" ? signals.explicit : 0;
  }
  if (requirement === "task_continuity") {
    if (signals.contextual > 0) return signals.contextual;
    return hasTaskContinuityProvenance(candidate)
      ? Math.max(signals.lexical, signals.graph, signals.explicit)
      : 0;
  }
  if (requirement === "recent_turn_hit") {
    return hasRecentTurnProvenance(candidate) ? Math.max(signals.contextual, signals.lexical) : 0;
  }
  return 0;
}

function strategyEvidenceScore(
  strategy: RetrievalStrategy,
  candidate: RecallCandidate,
  signals: RecallRankingSignals,
): number {
  if (strategy === "search_vector_episode") return evidenceRequirementScore("vector_episode_hit", candidate, signals);
  if (strategy === "search_lexical_memory") return signals.lexical;
  if (strategy === "read_graph_memory") return evidenceRequirementScore("graph_relation_hit", candidate, signals);
  if (strategy === "read_explicit_memory") return evidenceRequirementScore("explicit_rule_hit", candidate, signals);
  if (strategy === "read_task_state") return evidenceRequirementScore("task_continuity", candidate, signals);
  if (strategy === "read_recent_context") return Math.max(signals.contextual, evidenceRequirementScore("recent_turn_hit", candidate, signals));
  if (strategy === "query_exact_transcript") return 0;
  return 0;
}

function requirementForStrategy(strategy: RetrievalStrategy): RetrievalEvidenceRequirement | null {
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
    return Math.max(signals.semantic, signals.lexical, signals.contextual, signals.graph, signals.explicit);
  }
  const plannedScores = policy.strategies.map((strategy) =>
    plannedStrategyEvidenceScore(strategy, candidate, signals, policy),
  );
  const requiredScores = policy.evidenceRequired
    .filter((requirement) => requirement !== "exact_quote")
    .map((requirement) => evidenceRequirementScore(requirement, candidate, signals));
  return Math.max(...plannedScores, ...requiredScores, 0);
}

function recallPenalty(signals: RecallRankingSignals): number {
  return Math.max(signals.hub, signals.conflict, signals.superseded);
}

function fallbackRecallScore(signals: RecallRankingSignals): number {
  if (signals.superseded > 0) return 0;
  const evidence = Math.max(signals.semantic, signals.lexical, signals.contextual, signals.graph, signals.explicit);
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
  if (requiredScores.length > 0 && requiredScores.every((score) => score <= 0)) return 0;
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
    const leftIndex = plannedStrategyIndex(left.candidate, left.breakdown, policy);
    const rightIndex = plannedStrategyIndex(right.candidate, right.breakdown, policy);
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  }
  return right.breakdown.total - left.breakdown.total;
}

function sourceForCandidate(candidate: RecallCandidate, semantic: number, graph: number): RecallSource {
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
    return (item.source === "project-memory" || item.originalSource === "project-memory") &&
      Math.max(breakdown.lexical_match, breakdown.contextual_match, breakdown.graph_activation) > 0;
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
      item.provenance.some((entry) => entry.startsWith("session:") || entry.startsWith("turn:"))) &&
      Math.max(breakdown.contextual_match, breakdown.lexical_match) > 0;
  }
  if (requirement === "task_continuity") {
    if (breakdown.contextual_match > 0) return true;
    return item.provenance.some((entry) => entry.startsWith("task:") || entry.includes(":task:")) &&
      Math.max(breakdown.lexical_match, breakdown.graph_activation, breakdown.explicit_salience) > 0;
  }
  return false;
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
  const limit = Math.max(1, Math.min(10, Math.trunc(input.limit ?? DEFAULT_LIMIT)));
  const now = input.now ?? Date.now();
  const activation = activateGraph(input.corpus, seeds);
  const lexicalStats = buildLexicalStats(input.corpus.candidates, seeds);
  const contextualEvidence = buildContextualRecallEvidence(input.context, input.corpus);
  const degree = buildDegreeMap(input.corpus);
  const activeCandidateIds = new Set(input.corpus.candidates.map((candidate) => candidate.id));
  const effectivePolicy = input.rankingPolicy ?? input.evidencePolicy;
  const recallPolicy = activeRecallPolicy(effectivePolicy);

  const scored = input.corpus.candidates
    .map((candidate) => {
      const signals: RecallRankingSignals = {
        semantic: semanticScore(candidate),
        lexical: lexicalScore(candidate, lexicalStats),
        contextual: contextualScore(candidate, contextualEvidence),
        graph: candidateGraphActivation(candidate, activation),
        recency: recencyScore(candidate.timestamp, now),
        frequency: frequencyScore(candidate.frequency),
        explicit: candidate.explicitSalience ?? (candidate.source === "explicit" ? 1 : 0),
        boost: candidateBoost(candidate),
        hub: candidateHubPenalty(candidate, degree),
        conflict: candidateConflictPenalty(candidate, activeCandidateIds),
        superseded: candidate.supersededBy && activeCandidateIds.has(candidate.supersededBy)
          ? SUPERSEDED_MEMORY_PENALTY
          : 0,
      };
      const evidence = evidenceConfidence(candidate, signals, recallPolicy);
      const total = plannedRecallScore(candidate, signals, recallPolicy);
      const hasEvidence = evidence > 0;
      return {
        candidate,
        hasEvidence,
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
  const rawItems = scored
    .filter((item) => item.breakdown.total >= minScore)
    .slice(0, plannedEvidenceLimit)
    .map(({ candidate, breakdown }) => ({
      summary: candidate.summary,
      confidence: Math.max(0, Math.min(1, breakdown.total)),
      source: sourceForCandidate(candidate, breakdown.semantic_similarity, breakdown.graph_activation),
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
      `activated_nodes=${[...activation.values()].filter((value) => value > 0).length}`,
      `ranking=${recallPolicy.planned ? "planned_policy" : "fallback_evidence"}`,
      `ranking_policy=${recallPolicy.planned ? "planned" : "fallback"}`,
      `context_terms=${contextualEvidence?.terms.size ?? 0}`,
      `contextual_candidates=${rawItems.filter((item) => item.score_breakdown.contextual_match > 0).length}`,
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
    const missingRequiredEvidence = evidenceRequired.filter((requirement) => requirement !== "exact_quote");
    for (const requirement of missingRequiredEvidence) diagnostics.push(`evidence_missing=${requirement}`);
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
      (breakdown.conflict_penalty > 0 || breakdown.stale_superseded_penalty > 0);
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
    .filter((requirement) => !usableItems.some((item) => itemSatisfiesEvidenceRequirement(item, requirement)));
  for (const requirement of missingRequiredEvidence) diagnostics.push(`evidence_missing=${requirement}`);
  if (missingRequiredEvidence.length > 0) {
    return {
      verified: false,
      items: [],
      diagnostics,
      nextAction: "try_alternate_retrieval",
    };
  }

  const nonExactRequiredEvidence = evidenceRequired.filter((requirement) => requirement !== "exact_quote");
  const evidenceScopedItems = nonExactRequiredEvidence.length === 0
    ? usableItems
    : usableItems.filter((item) =>
      nonExactRequiredEvidence.some((requirement) => itemSatisfiesEvidenceRequirement(item, requirement)),
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
    const key = item.source === "hot-cache" ? "source_hot_cache_count" : `source_${item.source}_count`;
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
      candidates_count: numericDiagnostic(input.result.diagnostics, "candidates"),
      activated_nodes_count: numericDiagnostic(input.result.diagnostics, "activated_nodes"),
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
    summary: input.summary ?? compact(input.text, 180),
    text: input.text,
    source: input.source,
    originalSource: input.originalSource,
    explicitSalience: input.explicitSalience,
    provenance: [input.path],
  };
}

function loadGraphCandidates(input: {
  butlerData: string;
  projectId?: string;
}): { nodes: RecallNode[]; edges: RecallEdge[]; candidates: RecallCandidate[] } {
  const { butlerData, projectId } = input;
  const path = join(cognitionMemoryRoot(butlerData), "db", "graph.sqlite");
  if (!existsSync(path)) return { nodes: [], edges: [], candidates: [] };
  try {
    const db = new Database(path, { readonly: true });
    try {
      const nodes = db.prepare(`
        SELECT e.id, e.type, e.name, COUNT(edge.id) AS degree
        FROM entities e
        LEFT JOIN edges edge ON edge.source_id = e.id OR edge.target_id = e.id
        GROUP BY e.id
      `).all() as Array<{ id: string; type: string; name: string; degree: number }>;
      const edges = db.prepare(`
        SELECT source_id AS sourceId, target_id AS targetId, rel_type AS relType, weight
        FROM edges
      `).all() as RecallEdge[];
      const projectWhere = projectId ? "AND (m.project = ? OR e.project = ?)" : "";
      const mentionParams = projectId ? [projectId, projectId] : [];
      const mentions = db.prepare(`
        SELECT m.id, m.entity_id, m.session_id, m.timestamp, m.snippet, e.name
        FROM entity_mentions m
        JOIN entities e ON e.id = m.entity_id
        WHERE m.snippet IS NOT NULL AND length(m.snippet) > 0
        ${projectWhere}
        ORDER BY m.timestamp DESC
        LIMIT 200
      `).all(...mentionParams) as Array<{
        id: number;
        entity_id: string;
        session_id: string;
        timestamp: number;
        snippet: string;
        name: string;
      }>;
      return {
        nodes,
        edges,
        candidates: mentions.map((mention) => ({
          id: `graph:${mention.id}`,
          summary: compact(mention.snippet, 180),
          text: mention.snippet,
          source: "graph",
          originalSource: "graph",
          provenance: [`graph:${mention.session_id}`],
          relatedNodes: [mention.entity_id],
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

export function loadRecallCorpus(input: { butlerData: string; projectId?: string }): RecallCorpus {
  const memoryDir = cognitionMemoryRoot(input.butlerData);
  const hotDir = join(memoryDir, "hot");
  const projectId = input.projectId?.trim();
  const candidates: RecallCandidate[] = [];
  const hotCacheHints: string[] = [];

  for (const path of [
    ...listFiles(hotDir, (name) => name.endsWith(".md")),
    ...listFiles(join(hotDir, "topics"), (name) => name.endsWith(".md")),
  ]) {
    const text = readText(path);
    if (!text.trim()) continue;
    hotCacheHints.push(compact(text, 240));
    candidates.push(fileCandidate({
      id: `hot:${path}`,
      path,
      text,
      source: "hot-cache",
      originalSource: "hot-cache",
    }));
  }

  const taskMemoryDir = join(memoryDir, "tasks");
  for (const path of listFiles(taskMemoryDir, (name) => name.endsWith(".md"))) {
    const text = readText(path);
    if (!text.trim()) continue;
    if (projectId && !text.toLowerCase().includes(projectId.toLowerCase())) continue;
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
  for (const path of listFiles(projectMemoryDir, (name) => name.endsWith(".md"))) {
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
      vectorQueries.map((query) =>
        searchVectorEpisodes({
          butlerData: input.butlerData,
          query,
          projectId: input.projectId,
          limit: input.limit,
          timeoutMs: input.vectorTimeoutMs,
          backend: input.vectorBackend,
        }),
      ),
    );
    for (const vectorResult of vectorResults) {
      corpus.candidates.push(...vectorResult.candidates);
      vectorDiagnostics.push(...vectorResult.diagnostics);
    }
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
}): typeof recallMemory {
  const ttlMs = Math.max(1000, input.ttlMs ?? DEFAULT_RECALL_CACHE_TTL_MS);
  let cachedAt = 0;
  let cachedCorpus: RecallCorpus | null = null;
  let cachedProjectId: string | undefined;

  return (request) => {
    const now = Date.now();
    const projectId = request.projectId?.trim() || undefined;
    if (!cachedCorpus || now - cachedAt > ttlMs || request.butlerData !== input.butlerData || cachedProjectId !== projectId) {
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
}
