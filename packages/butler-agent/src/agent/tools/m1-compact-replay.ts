import type { FunctionToolDefinition } from
  "../../integrations/providers/runtime-contracts.ts";

export const M1_COMPACT_REPLAY_FLAG = "BUTLER_M1_COMPACT_REPLAY" as const;
export const M1_COMPACT_REPLAY_FLAG_REVISION = "m1-t3-v1" as const;
export const READ_OPERATION_RESULTS_TOOL_NAME =
  "read_operation_results" as const;
export const REPLACE_PHASE_CONTINUITY_TOOL_NAME =
  "replace_phase_continuity" as const;
export const M1_COMPACT_REPLAY_OPERATION_CARRIER_INSTRUCTION = [
  "Every tool-calling model response is one complete compact replay operation carrier.",
  "Emit exactly one replace_phase_continuity call and put at least one requested operation in its required operations array.",
  "The runtime rewrites continuity first, then dispatches the nested operations in array order only after that rewrite succeeds.",
  "Never omit operations or emit separate top-level operation calls; an incomplete or mixed carrier is rejected and nothing is dispatched.",
].join(" ");

export type GuidedOperationResultViewSelector =
  | { kind: "json_pointer"; pointer: string }
  | {
    kind: "line_range";
    pointer: string;
    start_line: number;
    end_line: number;
  }
  | {
    kind: "byte_range";
    pointer: string;
    start_byte: number;
    end_byte: number;
  }
  | {
    kind: "search";
    pointer: string;
    query: string;
    max_matches: number;
  };

const VIEW_SELECTOR_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "json_pointer" },
        pointer: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["kind", "pointer"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "line_range" },
        pointer: { type: "string", minLength: 1, maxLength: 500 },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
      },
      required: ["kind", "pointer", "start_line", "end_line"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "byte_range" },
        pointer: { type: "string", minLength: 1, maxLength: 500 },
        start_byte: { type: "integer", minimum: 0 },
        end_byte: { type: "integer", minimum: 1 },
      },
      required: ["kind", "pointer", "start_byte", "end_byte"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "search" },
        pointer: { type: "string", minLength: 1, maxLength: 500 },
        query: { type: "string", minLength: 1, maxLength: 500 },
        max_matches: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["kind", "pointer", "query", "max_matches"],
    },
  ],
} as const;

export const M1_COMPACT_REPLAY_TOOL_DEFINITIONS: readonly FunctionToolDefinition[] =
  Object.freeze([
    {
      type: "function",
      name: REPLACE_PHASE_CONTINUITY_TOOL_NAME,
      description: [
        "Replace the durable model-authored continuity state for this Guided phase.",
        M1_COMPACT_REPLAY_OPERATION_CARRIER_INSTRUCTION,
        "State only integrated decisions and unresolved work; do not copy raw tool payloads.",
      ].join(" "),
      concurrencySafe: false,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          objective_state: { type: "string", minLength: 1, maxLength: 1_200 },
          integrated_decisions: {
            type: "array",
            maxItems: 12,
            items: { type: "string", minLength: 1, maxLength: 500 },
          },
          unresolved_questions: {
            type: "array",
            maxItems: 12,
            items: { type: "string", minLength: 1, maxLength: 500 },
          },
          next_batch_purpose: { type: "string", minLength: 1, maxLength: 800 },
          public_activity: { type: "string", minLength: 1, maxLength: 500 },
          operations: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string", minLength: 1, maxLength: 120 },
                operation_id: { type: "string", minLength: 1, maxLength: 160 },
                arguments: { type: "object" },
              },
              required: ["operation_id", "name", "arguments"],
            },
          },
        },
        required: [
          "objective_state",
          "integrated_decisions",
          "unresolved_questions",
          "next_batch_purpose",
          "public_activity",
          "operations",
        ],
      },
    },
    {
      type: "function",
      name: READ_OPERATION_RESULTS_TOOL_NAME,
      description: [
        "Read one to four bounded exact views from durable operation results by the identity fields shown in compact context.",
        "This is read-only and never reruns the source operation.",
        "Copy every identity field exactly and select /request, /result, or /record with a JSON pointer, line range, byte range, or literal search.",
        "Missing captures, stale identities, and oversized selected views are rejected.",
      ].join(" "),
      concurrencySafe: false,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          reads: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    kind: { type: "string", const: "work" },
                    result_ref: { type: "string", minLength: 1 },
                    work_id: { type: "string", minLength: 1 },
                    revision: { type: "integer", minimum: 1 },
                    result_sha256: {
                      oneOf: [
                        { type: "string", pattern: "^[a-f0-9]{64}$" },
                        { type: "null" },
                      ],
                    },
                    selector: VIEW_SELECTOR_SCHEMA,
                  },
                  required: [
                    "kind", "result_ref", "work_id", "revision",
                    "result_sha256", "selector",
                  ],
                },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    kind: { type: "string", const: "direct" },
                    result_ref: { type: "string", minLength: 1 },
                    revision: { type: "null" },
                    result_sha256: {
                      oneOf: [
                        { type: "string", pattern: "^[a-f0-9]{64}$" },
                        { type: "null" },
                      ],
                    },
                    selector: VIEW_SELECTOR_SCHEMA,
                  },
                  required: [
                    "kind", "result_ref", "revision", "result_sha256",
                    "selector",
                  ],
                },
              ],
            },
          },
        },
        required: ["reads"],
      },
    },
  ]);

/** Derives the atomic carrier's operation union from the fixed phase tools. */
export function withM1CompactReplayOperationCarrier(
  tools: readonly FunctionToolDefinition[],
): FunctionToolDefinition[] {
  const operations = tools.filter((tool) =>
    tool.name !== REPLACE_PHASE_CONTINUITY_TOOL_NAME);
  return tools.map((tool) => {
    if (tool.name !== REPLACE_PHASE_CONTINUITY_TOOL_NAME) return tool;
    const properties = tool.parameters.properties &&
        typeof tool.parameters.properties === "object" &&
        !Array.isArray(tool.parameters.properties)
      ? tool.parameters.properties as Record<string, unknown>
      : {};
    return {
      ...tool,
      parameters: {
        ...tool.parameters,
        properties: {
          ...properties,
          operations: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              oneOf: operations.map((operation) => ({
                type: "object",
                additionalProperties: false,
                properties: {
                  name: { type: "string", const: operation.name },
                  operation_id: {
                    type: "string",
                    minLength: 1,
                    maxLength: 160,
                  },
                  arguments: operation.parameters,
                },
                required: ["operation_id", "name", "arguments"],
              })),
            },
          },
        },
      },
    };
  });
}

export type PhaseContinuity = {
  objectiveState: string;
  integratedDecisions: string[];
  unresolvedQuestions: string[];
  nextBatchPurpose: string;
  publicActivity: string;
};

export function isM1CompactReplayControlTool(name: string): boolean {
  return name === READ_OPERATION_RESULTS_TOOL_NAME ||
    name === REPLACE_PHASE_CONTINUITY_TOOL_NAME;
}

const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);

/** The guided-turn-agent owns the single read of this flag. */
export function isM1CompactReplayEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return TRUE_VALUES.has(
    env[M1_COMPACT_REPLAY_FLAG]?.trim().toLowerCase() ?? "",
  );
}
