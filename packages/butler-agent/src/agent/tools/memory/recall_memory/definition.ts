import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const recallMemoryToolDefinition = {
  type: "function",
  name: "recall_memory",
  description: "Recall relevant local Butler memory for prior task outcomes, hot-cache context, explicit rules, and associative context. Use results[].text as the primary safe memory evidence; items are ranking diagnostics. Treat results as candidate memory evidence, not exact chronological database truth.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      cue: {
        type: "string",
        description: "Memory recall cue text.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of memory recall results.",
      },
      include_vector: {
        type: "boolean",
        description: "Whether to try vector episode search in addition to lexical, graph, project/task, and explicit memory. Defaults to true for tool calls.",
      },
      vector_queries: {
        type: "array",
        description: "Optional planner-expanded semantic episode queries.",
        items: {
          type: "string",
        },
      },
      generated_queries: {
        type: "array",
        description: "Optional structured retrieval-plan queries. `search_vector_episode` queries are used as vector episode queries.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            strategy: {
              type: "string",
              enum: [
                "read_recent_context",
                "query_exact_transcript",
                "search_lexical_memory",
                "search_vector_episode",
                "read_graph_memory",
                "read_explicit_memory",
                "read_task_state",
              ],
            },
            query: {
              type: "string",
            },
          },
          required: [
            "strategy",
            "query",
          ],
        },
      },
      strategies: {
        type: "array",
        description: "Optional model-selected retrieval strategies for this recall. Use this to make ranking follow the planned evidence path instead of the fallback scorer.",
        items: {
          type: "string",
          enum: [
            "read_recent_context",
            "query_exact_transcript",
            "search_lexical_memory",
            "search_vector_episode",
            "read_graph_memory",
            "read_explicit_memory",
            "read_task_state",
          ],
        },
      },
      evidence_required: {
        type: "array",
        description: "Optional evidence types this recall must prove before Butler can use the result.",
        items: {
          type: "string",
          enum: [
            "exact_quote",
            "recent_turn_hit",
            "task_continuity",
            "project_memory_hit",
            "vector_episode_hit",
            "explicit_rule_hit",
            "graph_relation_hit",
          ],
        },
      },
    },
    required: [
      "cue",
    ],
  },
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const recallMemoryToolMetadata = {
  category: "memory",
  tags: [
    "memory",
    "recall",
    "association",
    "search",
  ],
  safetyNotes: [
    "Treat recall as evidence to consider, not guaranteed truth.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
