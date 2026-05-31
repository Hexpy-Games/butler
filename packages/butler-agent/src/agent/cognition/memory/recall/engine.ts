import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, join } from "path";
import { Database } from "bun:sqlite";
import { sanitizeProjectMemoryId } from "../project-memory.ts";
import { cognitionMemoryRoot } from "../../paths.ts";
import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";

export type RecallSource = "hot-cache" | "vector" | "graph" | "explicit" | "hybrid";

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
  supersededBy?: string;
  contradicts?: string[];
}

export interface RecallCorpus {
  hotCacheHints?: string[];
  nodes: RecallNode[];
  edges: RecallEdge[];
  candidates: RecallCandidate[];
}

export interface RecallScoreBreakdown {
  semantic_similarity: number;
  graph_activation: number;
  recency_score: number;
  frequency_score: number;
  explicit_salience: number;
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

const DEFAULT_LIMIT = 5;

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
    .filter((part) => part.length >= 2)
    .filter((part, index, values) => values.indexOf(part) === index)
    .slice(0, 24);
}

function keywordScore(text: string, seeds: string[]): number {
  if (seeds.length === 0) return 0;
  const lower = text.toLowerCase();
  const hits = seeds.filter((seed) => lower.includes(seed)).length;
  return hits / seeds.length;
}

function recencyScore(timestamp: number | undefined, now: number): number {
  if (!timestamp) return 0.15;
  const ageMs = Math.max(0, now - timestamp * 1000);
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  return Math.max(0, 1 - ageMs / thirtyDaysMs);
}

function frequencyScore(value: number | undefined): number {
  return Math.min(1, Math.log1p(value ?? 0) / Math.log1p(8));
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

  for (let hop = 0; hop < 2; hop += 1) {
    const next = new Map(activation);
    for (const edge of corpus.edges) {
      const weight = edge.weight ?? 1;
      const spread = 0.58 * Math.min(2, weight) / (1 + (degree.get(edge.sourceId) ?? 0));
      const reverseSpread = 0.45 * Math.min(2, weight) / (1 + (degree.get(edge.targetId) ?? 0));
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
  return Math.max(...nodes.map((node) => Math.min(1, Math.max(0, ((degree.get(node) ?? 0) - 8) / 40))), 0);
}

function candidateConflictPenalty(candidate: RecallCandidate, activeCandidateIds: Set<string>): number {
  return candidate.contradicts?.some((id) => activeCandidateIds.has(id)) ? 0.4 : 0;
}

function candidateBoost(candidate: RecallCandidate): number {
  void candidate;
  return 0;
}

function sourceForCandidate(candidate: RecallCandidate, semantic: number, graph: number): RecallSource {
  if (candidate.source === "explicit") return "explicit";
  if (graph > 0 && semantic > 0) return "hybrid";
  if (graph > 0) return "graph";
  return candidate.source;
}

export function recallFromCorpus(input: {
  cue: string;
  corpus: RecallCorpus;
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
  const degree = buildDegreeMap(input.corpus);
  const activeCandidateIds = new Set(input.corpus.candidates.map((candidate) => candidate.id));

  const scored = input.corpus.candidates
    .map((candidate) => {
      const semantic = keywordScore(`${candidate.summary}\n${candidate.text}`, seeds);
      const graph = candidateGraphActivation(candidate, activation);
      const recency = recencyScore(candidate.timestamp, now);
      const frequency = frequencyScore(candidate.frequency);
      const explicit = candidate.explicitSalience ?? (candidate.source === "explicit" ? 1 : 0);
      const boost = candidateBoost(candidate);
      const hub = candidateHubPenalty(candidate, degree);
      const conflict = candidateConflictPenalty(candidate, activeCandidateIds);
      const superseded = candidate.supersededBy && activeCandidateIds.has(candidate.supersededBy) ? 0.7 : 0;
      const total =
        semantic * 0.38 +
        graph * 0.32 +
        recency * 0.08 +
        frequency * 0.07 +
        explicit * 0.18 +
        boost -
        hub * 0.25 -
        conflict -
        superseded;
      const hasEvidence = semantic > 0 || graph > 0 || explicit > 0;
      return {
        candidate,
        hasEvidence,
        breakdown: {
          semantic_similarity: semantic,
          graph_activation: graph,
          recency_score: recency,
          frequency_score: frequency,
          explicit_salience: explicit,
          decision_preference_boost: boost,
          hub_penalty: hub,
          conflict_penalty: conflict,
          stale_superseded_penalty: superseded,
          total,
        },
      };
    })
    .filter((item) => item.hasEvidence)
    .filter((item) => item.breakdown.total > 0)
    .sort((left, right) => right.breakdown.total - left.breakdown.total);

  // Initial threshold: below this, tests showed recency/frequency can feel like
  // false memory even when no semantic, graph, or explicit evidence exists.
  const minScore = input.minScore ?? 0.22;
  const items = scored
    .filter((item) => item.breakdown.total >= minScore)
    .slice(0, limit)
    .map(({ candidate, breakdown }) => ({
      summary: candidate.summary,
      confidence: Math.max(0, Math.min(1, breakdown.total)),
      source: sourceForCandidate(candidate, breakdown.semantic_similarity, breakdown.graph_activation),
      originalSource: candidate.originalSource,
      provenance: candidate.provenance,
      related_nodes: candidate.relatedNodes ?? [],
      score_breakdown: breakdown,
    }));

  return {
    cue,
    seeds,
    items,
    abstained: items.length === 0,
    diagnostics: [
      `candidates=${input.corpus.candidates.length}`,
      `activated_nodes=${[...activation.values()].filter((value) => value > 0).length}`,
      items.length === 0 ? "abstained=low-confidence" : "abstained=false",
    ],
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
      source: "vector",
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
      source: "vector",
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

export function createCachedRecallMemoryRunner(input: {
  butlerData: string;
  ttlMs?: number;
}): typeof recallMemory {
  const ttlMs = Math.max(1000, input.ttlMs ?? 30_000);
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
