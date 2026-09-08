import { resolveMemoryGeneration } from "./generation.ts";
import type { MemoryExecutionContext } from "./contracts.ts";
import { resolveMemorySource } from "./ingestion.ts";
import { openProjectionDb } from "./store.ts";
import { unicodeCaseFold } from "./unicode.ts";

type RecallInput = {
  context: MemoryExecutionContext;
  cue: string;
  includeVector: boolean;
  limit: number;
  sessionId: string;
  projectId: string | null;
};

type GraphEdge = {
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  rel_type: string;
  claim_node_id: string | null;
};

type Mention = {
  entity_id: string;
  source_id: string;
  episode_id: string;
  revision: string;
};

export function recallMemory(input: RecallInput) {
  const generation = resolveMemoryGeneration(input.context);
  const db = openProjectionDb(generation.graphPath, true);
  try {
    const folded = unicodeCaseFold(input.cue);
    if (!folded) return emptyRecall(input.includeVector, "no_hits");

    const seeds = db
      .query<{ id: string }, [string, string, string | null]>(
        `
      SELECT DISTINCT e.id
      FROM entity_aliases a
      JOIN entities e ON e.id=a.entity_id
      JOIN memory_chunk_sources s ON s.source_id=a.source_id
      JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
      WHERE (a.folded_key=? OR instr(a.folded_key,?)>0)
        AND s.origin_kind IN ('user_input','assistant_public')
        AND c.project_id IS ?
      ORDER BY length(a.folded_key) DESC,e.id
      LIMIT 32
    `,
      )
      .all(folded, folded, input.projectId)
      .map((row) => row.id);
    if (seeds.length === 0) return emptyRecall(input.includeVector, "no_hits");

    const allowedNodes = db
      .query<{ id: string }, [string | null]>(
        `
      SELECT DISTINCT m.entity_id AS id
      FROM entity_mentions m
      JOIN memory_chunk_sources s ON s.source_id=m.source_id
      JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
      WHERE s.origin_kind IN ('user_input','assistant_public')
        AND c.project_id IS ?
    `,
      )
      .all(input.projectId)
      .map((row) => row.id);
    const allowed = new Set(allowedNodes);
    const scopedSeeds = seeds.filter((seed) => allowed.has(seed));
    if (scopedSeeds.length === 0)
      return emptyRecall(input.includeVector, "no_hits");

    const placeholders = allowedNodes.map(() => "?").join(",");
    const edges =
      allowedNodes.length === 0
        ? []
        : db
            .query<GraphEdge, string[]>(
              `
      SELECT * FROM edges
      WHERE source_node_id IN (${placeholders})
        AND target_node_id IN (${placeholders})
      ORDER BY edge_id
    `,
            )
            .all(...allowedNodes, ...allowedNodes);
    const reachableIds = [...nodesWithinDepth(scopedSeeds, edges, 2)];
    const mentions =
      reachableIds.length === 0
        ? []
        : db
            .query<Mention, Array<string | null>>(
              `
      SELECT m.*
      FROM entity_mentions m
      JOIN memory_chunk_sources s ON s.source_id=m.source_id
      JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
      WHERE m.entity_id IN (${reachableIds.map(() => "?").join(",")})
        AND s.origin_kind IN ('user_input','assistant_public')
        AND c.project_id IS ?
      ORDER BY c.conversation_start,m.episode_id,m.source_id
    `,
            )
            .all(...reachableIds, input.projectId);

    const episodes = [
      ...new Set(mentions.map((mention) => mention.episode_id)),
    ].slice(0, input.limit);
    const results = episodes
      .map((episode) =>
        buildResult({
          input,
          db,
          episode,
          mentions,
          edges,
          seeds: scopedSeeds,
        }),
      )
      .filter((result) => result.evidence.length > 0);
    return {
      status: results.length ? "partial" : "complete",
      results,
      coverage: {
        graph: { state: "ok", candidates: episodes.length, codes: [] },
        vectors: input.includeVector
          ? {
              state: "unavailable",
              candidates: 0,
              codes: ["vector_stage_deferred"],
            }
          : { state: "disabled_by_request", candidates: 0, codes: [] },
        source: { state: "ok", candidates: mentions.length, codes: [] },
      },
      next_cursor: null,
      diagnostics: results.length ? ["ranking_stage_deferred"] : [],
    };
  } finally {
    db.close();
  }
}

function buildResult(input: {
  input: RecallInput;
  db: ReturnType<typeof openProjectionDb>;
  episode: string;
  mentions: Mention[];
  edges: GraphEdge[];
  seeds: string[];
}) {
  const chunk = input.db
    .query<
      {
        summary: string;
        conversation_start: string | null;
        current_revision: string;
        project_id: string | null;
      },
      [string]
    >(
      "SELECT summary,conversation_start,current_revision,project_id FROM memory_chunks WHERE memory_chunk_id=?",
    )
    .get(input.episode)!;
  const episodeMentions = input.mentions.filter(
    (mention) => mention.episode_id === input.episode,
  );
  const target =
    episodeMentions.find((mention) => input.seeds.includes(mention.entity_id))
      ?.entity_id ??
    episodeMentions[0]?.entity_id ??
    null;
  const path = target ? shortestPath(input.seeds, target, input.edges, 2) : [];
  const evidence = episodeMentions.slice(0, 3).map((mention) => {
    const source = resolveMemorySource({
      context: input.input.context,
      sourceRef: mention.source_id,
      maxChars: 480,
    });
    return {
      source_ref: source.source_ref,
      basis: source.basis,
      excerpt: source.excerpt,
      source_resolved: true as const,
      conversation_session_id: source.conversation_session_id,
      conversation_message_id: source.conversation_message_id,
      support: { node_ref: mention.entity_id, relation: "mentions" as const },
      read_args: {
        scope: input.input.projectId ? "current_project" : "all_user_sessions",
        source_ref: source.source_ref,
        max_chars: 12000,
      },
    };
  });
  return {
    episode_ref: input.episode,
    revision: chunk.current_revision,
    summary: chunk.summary,
    occurred_at: null,
    conversation_at: chunk.conversation_start,
    channels: ["graph" as const],
    matched_node_ref: path.length > 0 ? (path[0]?.from ?? target) : target,
    association_path: path,
    evidence,
    qualifications: [],
  };
}

function nodesWithinDepth(
  seeds: string[],
  edges: GraphEdge[],
  maxDepth: number,
): Set<string> {
  const seen = new Set(seeds);
  let frontier = [...seeds];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const edge of edges) {
        const neighbor =
          edge.source_node_id === node
            ? edge.target_node_id
            : edge.target_node_id === node
              ? edge.source_node_id
              : null;
        if (neighbor && !seen.has(neighbor)) {
          seen.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

function shortestPath(
  seeds: string[],
  target: string,
  edges: GraphEdge[],
  maxDepth: number,
) {
  const queue = seeds.map((seed) => ({
    node: seed,
    path: [] as Array<{
      from: string;
      relation: string;
      to: string;
      traversed_reverse: boolean;
    }>,
  }));
  const seen = new Set(seeds);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.node === target) return current.path;
    if (current.path.length >= maxDepth) continue;
    for (const edge of edges) {
      const forward = edge.source_node_id === current.node;
      const reverse = edge.target_node_id === current.node;
      if (!forward && !reverse) continue;
      const neighbor = forward ? edge.target_node_id : edge.source_node_id;
      if (seen.has(neighbor)) continue;
      seen.add(neighbor);
      queue.push({
        node: neighbor,
        path: [
          ...current.path,
          {
            from: current.node,
            relation: edge.rel_type,
            to: neighbor,
            traversed_reverse: reverse,
          },
        ],
      });
    }
  }
  return [];
}

function emptyRecall(includeVector: boolean, code: string) {
  return {
    status: "complete",
    results: [],
    coverage: {
      graph: { state: "ok", candidates: 0, codes: [code] },
      vectors: includeVector
        ? {
            state: "unavailable",
            candidates: 0,
            codes: ["vector_stage_deferred"],
          }
        : { state: "disabled_by_request", candidates: 0, codes: [] },
      source: { state: "ok", candidates: 0, codes: [] },
    },
    next_cursor: null,
    diagnostics: [],
  };
}
