import type { FunctionToolDefinition } from "../../../../integrations/providers/provider.ts";
import {
  validateJsonObjectSchema,
  type SchemaValidationResult,
} from "../../../tools/tool-bridge/schema-validation.ts";
import type { PublicWorkDecisionEnvelope } from "../../../output/public-work/decisions.ts";
import {
  parsePublicWorkDecisionRepair,
  publicWorkDecisionRepairResponseFormat,
  validatePublicWorkDecisionRepair,
} from "./public-work-decision-repair.ts";
import type { ObligationToolSurfaceState } from "./obligation-tool-surface.ts";

export const WORK_BLOCK_TOOL_NAME = "run_work_block";
export const WORK_BLOCK_CALL_LIMIT = 6;

export interface EmbeddedWorkBlockCall {
  name: string;
  args: Record<string, unknown>;
}

export interface WorkBlockToolExecutionResult {
  butler_work_block_result: true;
  decision_feedback?: {
    status: "repaired";
    correction: string;
  };
  frontier?: ObligationToolSurfaceState;
  results: Array<{
    name: string;
    args: Record<string, unknown>;
    ok: boolean;
    output?: unknown;
    error?: string;
  }>;
}

export function workBlockTool(tools: readonly FunctionToolDefinition[]): FunctionToolDefinition {
  const ordinaryTools = tools.filter((tool) => tool.name !== WORK_BLOCK_TOOL_NAME);
  const callSchemas = ordinaryTools.map((tool) => ({
    type: "object",
    additionalProperties: false,
    required: ["name", "args"],
    properties: {
      name: { type: "string", const: tool.name },
      args: tool.parameters,
    },
  }));
  const decisionSchema = publicWorkDecisionRepairResponseFormat().schema;
  const singleTool = ordinaryTools.length === 1 ? ordinaryTools[0] : undefined;
  return {
    type: "function",
    name: WORK_BLOCK_TOOL_NAME,
    description: [
      "Execute one explicit semantic work block.",
      "Provide one concise visible decision and one to six ordinary calls in stable order.",
      "Decision title, objective, rationale, and next_step are required; expected_effect is optional and defaults to next_step.",
      `Available calls: ${ordinaryTools.map((tool) => tool.name).join(", ") || "none"}.`,
    ].join(" "),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: singleTool ? ["decision", "args"] : ["decision", "calls"],
      properties: singleTool
        ? {
          decision: decisionSchema,
          args: singleTool.parameters,
        }
        : {
          decision: decisionSchema,
          calls: {
            type: "array",
            minItems: 1,
            maxItems: WORK_BLOCK_CALL_LIMIT,
            items: { oneOf: callSchemas },
          },
        },
    },
  };
}

export function isWorkBlockTool(name: string): boolean {
  return name === WORK_BLOCK_TOOL_NAME;
}

export function workBlockEnvelope(
  args: Record<string, unknown>,
): PublicWorkDecisionEnvelope | null {
  const validation = validateWorkBlockDecision(args);
  if (!validation.ok) return null;
  return parsePublicWorkDecisionRepair(JSON.stringify(validation.canonicalArgs));
}

export function validateWorkBlockDecision(
  args: Record<string, unknown>,
): ReturnType<typeof validatePublicWorkDecisionRepair> {
  return validatePublicWorkDecisionRepair(record(args.decision));
}

export function embeddedWorkBlockCalls(
  args: Record<string, unknown>,
  availableTools: readonly FunctionToolDefinition[],
): EmbeddedWorkBlockCall[] {
  const allowed = new Set(availableTools.map((tool) => tool.name).filter((name) => name !== WORK_BLOCK_TOOL_NAME));
  const soleName = allowed.size === 1 ? [...allowed][0] : undefined;
  if (soleName && args.args && typeof args.args === "object" && !Array.isArray(args.args)) {
    return [{ name: soleName, args: record(args.args) }];
  }
  if (!Array.isArray(args.calls)) return [];
  return args.calls.slice(0, WORK_BLOCK_CALL_LIMIT).flatMap((value) => {
    const call = record(value);
    const requestedName = typeof call.name === "string" ? call.name.trim() : "";
    const name = requestedName || soleName || "";
    const callArgs = record(call.args);
    return name && allowed.has(name) ? [{ name, args: callArgs }] : [];
  });
}

export function validateEmbeddedWorkBlockCall(
  call: EmbeddedWorkBlockCall,
  availableTools: readonly FunctionToolDefinition[],
): SchemaValidationResult {
  const tool = availableTools.find((candidate) => candidate.name === call.name);
  if (!tool) {
    return {
      ok: false,
      message: `Tool is not available in this work block: ${call.name}`,
      path: "$.name",
      reason: "enum_mismatch",
    };
  }
  return validateJsonObjectSchema(call.args, tool.parameters);
}

export function isWorkBlockToolExecutionResult(value: unknown): value is WorkBlockToolExecutionResult {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).butler_work_block_result === true &&
    Array.isArray((value as Record<string, unknown>).results),
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
