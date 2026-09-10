import type { RecallAssociationStep, RecallEdge } from "./contracts.ts";
import { compareUtf8 } from "./candidates.ts";

export type EligibleAdjacency = { edges: RecallEdge[]; truncated: boolean };
export type GraphExpansion = {
  relevance: Map<string, number>;
  paths: Map<string, RecallAssociationStep[]>;
  edges: RecallEdge[];
  coverageCodes: string[];
};

type Adjacent = { edge: RecallEdge; neighbor: string; reverse: boolean };
type Frontier = {
  node: string;
  depth: number;
  path: RecallAssociationStep[];
  adjacency: Adjacent[] | null;
  cursor: number;
  offset: number;
  more: boolean;
  edgeIds: string[];
  seedIndex: number;
  identityLoaded: boolean;
};
type AdoptedPath = { steps: RecallAssociationStep[]; edgeIds: string[]; seedIndex: number };

const MAX_DEPTH = 3;
const MAX_NODES = 2_000;
const MAX_EDGES = 8_000;
const PPR_ALPHA = 0.2;
const PPR_PROPAGATION = 1 - PPR_ALPHA;
const PPR_EPSILON = 1e-6;
const PPR_MAX_ITERATIONS = 32;
const NAVIGATION_RELATIONS = new Set(["belongs_to", "co_occurred"]);
const POSITIVE_RELATIONS = new Set([
  "related_to", "depends_on", "likes", "dislikes", "decided",
  "has_subject", "has_object", ...NAVIGATION_RELATIONS,
]);

export function expandGraph(
  seeds: string[],
  loadEligibleAdjacency: (nodeId: string, limit: number, offset: number) => EligibleAdjacency,
  deadlineAt: number,
  loadIdentityMembers?: (nodeId: string, limit: number) => { members: string[]; partial: boolean },
): GraphExpansion {
  const adoptedPaths = new Map<string, AdoptedPath>(seeds.map((seed, seedIndex) => [seed, { steps: [], edgeIds: [], seedIndex }]));
  const queues = seeds.map((seed, seedIndex) => [{ node: seed, depth: 0, path: [], adjacency: null, cursor: 0, offset: 0, more: true, edgeIds: [], seedIndex, identityLoaded: false }] as Frontier[]);
  const localSeen = seeds.map((seed) => new Set([seed]));
  const localPaths = seeds.map((seed, seedIndex) => new Map<string, AdoptedPath>([[seed, { steps: [], edgeIds: [], seedIndex }]]));
  const adopted = new Map<string, RecallEdge>();
  const codes = new Set<string>();

  while (queues.some((queue) => queue.length)) {
    let progressed = false;
    for (let seedIndex = 0; seedIndex < queues.length; seedIndex += 1) {
      if (Date.now() >= deadlineAt) { codes.add("graph_deadline"); break; }
      const queue = queues[seedIndex]!;
      const frontier = queue[0];
      if (!frontier) continue;
      if (!frontier.identityLoaded && loadIdentityMembers) {
        frontier.identityLoaded = true;
        const remaining = Math.max(0, MAX_NODES - adoptedPaths.size);
        const identity = loadIdentityMembers(frontier.node, remaining);
        if (identity.partial) codes.add("identity_partial");
        for (const member of identity.members) {
          if (adoptedPaths.has(member)) continue;
          if (adoptedPaths.size >= MAX_NODES) { codes.add("graph_node_limit"); break; }
          const adoptedPath = { steps: frontier.path, edgeIds: frontier.edgeIds, seedIndex: frontier.seedIndex };
          adoptedPaths.set(member, adoptedPath);
          localPaths[seedIndex]!.set(member, adoptedPath);
          localSeen[seedIndex]!.add(member);
          queue.push({ node: member, depth: frontier.depth, path: frontier.path, adjacency: null, cursor: 0, offset: 0, more: true, edgeIds: frontier.edgeIds, seedIndex: frontier.seedIndex, identityLoaded: false });
        }
      }
      if (frontier.adjacency === null || frontier.cursor >= frontier.adjacency.length && frontier.more) {
        const pageSize = Math.min(256, Math.max(1, MAX_EDGES - adopted.size));
        const loaded = loadEligibleAdjacency(frontier.node, pageSize, frontier.offset);
        frontier.adjacency = sortAdjacency(frontier.node, loaded.edges);
        frontier.cursor = 0;
        frontier.offset += loaded.edges.length;
        frontier.more = loaded.truncated;
      }
      const adjacent = frontier.adjacency[frontier.cursor++];
      if (!adjacent) {
        queue.shift();
        progressed = true;
        continue;
      }
      progressed = true;
      const existingPath = adoptedPaths.get(adjacent.neighbor);
      if (frontier.depth >= MAX_DEPTH && !existingPath) {
        if (!adopted.has(adjacent.edge.edgeId)) codes.add("graph_depth_limit");
        continue;
      }
      if (!existingPath && adoptedPaths.size >= MAX_NODES) { codes.add("graph_node_limit"); continue; }
      if (!adopted.has(adjacent.edge.edgeId)) {
        if (adopted.size >= MAX_EDGES) { codes.add("graph_edge_limit"); break; }
        adopted.set(adjacent.edge.edgeId, adjacent.edge);
      }
      if (frontier.depth >= MAX_DEPTH) continue;
      const step: RecallAssociationStep = {
        from: adjacent.edge.sourceNodeId,
        relation: adjacent.edge.relation,
        to: adjacent.edge.targetNodeId,
        traversed_reverse: adjacent.reverse,
      };
      const nextPath = [...frontier.path, step];
      const candidatePath = { steps: nextPath, edgeIds: [...frontier.edgeIds, adjacent.edge.edgeId], seedIndex: frontier.seedIndex };
      if (!existingPath || comparePaths(candidatePath, existingPath) < 0) adoptedPaths.set(adjacent.neighbor, candidatePath);
      const localPath = localPaths[seedIndex]!.get(adjacent.neighbor);
      if (!localPath || comparePaths(candidatePath, localPath) < 0) {
        localPaths[seedIndex]!.set(adjacent.neighbor, candidatePath);
        const queued = queue.find((item) => item.node === adjacent.neighbor);
        if (queued && queued.adjacency === null) {
          queued.path = candidatePath.steps;
          queued.edgeIds = candidatePath.edgeIds;
        }
      }
      if (localSeen[seedIndex]!.has(adjacent.neighbor)) continue;
      localSeen[seedIndex]!.add(adjacent.neighbor);
      queue.push({ node: adjacent.neighbor, depth: frontier.depth + 1, path: nextPath, adjacency: null, cursor: 0, offset: 0, more: true, edgeIds: candidatePath.edgeIds, seedIndex: frontier.seedIndex, identityLoaded: false });
    }
    if (codes.has("graph_deadline") || codes.has("graph_edge_limit") || !progressed) break;
  }

  const edges = [...adopted.values()];
  const paths = new Map([...adoptedPaths].map(([nodeId, path]) => [nodeId, path.steps]));
  return {
    relevance: personalizedPageRank([...paths.keys()], seeds, edges),
    paths,
    edges,
    coverageCodes: [...codes].sort(compareUtf8),
  };
}

function comparePaths(a: AdoptedPath, b: AdoptedPath): number {
  if (a.steps.length !== b.steps.length) return a.steps.length - b.steps.length;
  if (a.seedIndex !== b.seedIndex) return a.seedIndex - b.seedIndex;
  for (let index = 0; index < Math.min(a.edgeIds.length, b.edgeIds.length); index += 1) {
    const delta = compareUtf8(a.edgeIds[index]!, b.edgeIds[index]!);
    if (delta) return delta;
  }
  return a.edgeIds.length - b.edgeIds.length;
}

function sortAdjacency(nodeId: string, edges: RecallEdge[]): Adjacent[] {
  return edges.filter((edge) => POSITIVE_RELATIONS.has(edge.relation)).map((edge) => {
    if (edge.sourceNodeId === nodeId) return { edge, neighbor: edge.targetNodeId, reverse: false };
    return { edge, neighbor: edge.sourceNodeId, reverse: true };
  }).sort((a, b) => {
    const classDelta = Number(NAVIGATION_RELATIONS.has(a.edge.relation)) - Number(NAVIGATION_RELATIONS.has(b.edge.relation));
    return classDelta || b.edge.support - a.edge.support || compareUtf8(a.edge.relation, b.edge.relation) ||
      compareUtf8(a.neighbor, b.neighbor) || compareUtf8(a.edge.edgeId, b.edge.edgeId);
  });
}

function personalizedPageRank(nodes: string[], seeds: string[], edges: RecallEdge[]): Map<string, number> {
  if (!nodes.length || !seeds.length) return new Map();
  const nodeSet = new Set(nodes);
  const seedWeights = seeds.map((_, index) => 1 / (60 + index + 1));
  const seedWeightTotal = seedWeights.reduce((sum, value) => sum + value, 0);
  const seedDistribution = new Map(seeds.map((seed, index) => [seed, seedWeights[index]! / seedWeightTotal]));
  const transitions = new Map<string, Array<{ node: string; weight: number }>>();
  for (const edge of edges) {
    if (!nodeSet.has(edge.sourceNodeId) || !nodeSet.has(edge.targetNodeId) || !POSITIVE_RELATIONS.has(edge.relation)) continue;
    const support = Math.log1p(edge.support);
    const relationFactor = NAVIGATION_RELATIONS.has(edge.relation) ? 0.25 : 1;
    push(transitions, edge.sourceNodeId, { node: edge.targetNodeId, weight: support * relationFactor });
    const reverseFactor = edge.relation === "related_to" || edge.relation === "co_occurred" ? 1 : 0.5;
    push(transitions, edge.targetNodeId, { node: edge.sourceNodeId, weight: support * relationFactor * reverseFactor });
  }
  let scores = new Map(nodes.map((node) => [node, seedDistribution.get(node) ?? 0]));
  for (let iteration = 0; iteration < PPR_MAX_ITERATIONS; iteration += 1) {
    const next = new Map(nodes.map((node) => [node, PPR_ALPHA * (seedDistribution.get(node) ?? 0)]));
    let dangling = 0;
    for (const node of nodes) {
      const outgoing = transitions.get(node) ?? [];
      const score = scores.get(node) ?? 0;
      const total = outgoing.reduce((sum, item) => sum + item.weight, 0);
      if (total <= 0) { dangling += score; continue; }
      for (const item of outgoing) next.set(item.node, (next.get(item.node) ?? 0) + PPR_PROPAGATION * score * item.weight / total);
    }
    for (const seed of seeds) next.set(seed, (next.get(seed) ?? 0) + PPR_PROPAGATION * dangling * (seedDistribution.get(seed) ?? 0));
    const delta = nodes.reduce((sum, node) => sum + Math.abs((next.get(node) ?? 0) - (scores.get(node) ?? 0)), 0);
    scores = next;
    if (delta <= PPR_EPSILON) break;
  }
  return scores;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}
