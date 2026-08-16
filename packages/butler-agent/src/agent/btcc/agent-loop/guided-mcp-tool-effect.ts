import type {
  EffectAdapter,
  EffectDispatchOutcome,
  EffectReconciliation,
} from "../effects/index.ts";
import type { ButlerToolCall } from "../../tools/butler-tools.ts";

export const GUIDED_MCP_TOOL_EFFECT_CAPABILITY = "call_mcp_tool";

export type GuidedMcpToolEffectInput = {
  server_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
};

type ExecuteRegisteredTool = (prepared?: {
  args: ButlerToolCall["args"];
  rawArguments?: ButlerToolCall["rawArguments"];
}) => Promise<unknown>;

export function prepareGuidedMcpToolEffect(input: {
  args: Record<string, unknown>;
  executeRegistered: ExecuteRegisteredTool;
}): {
  target: string;
  input: GuidedMcpToolEffectInput;
  adapter: EffectAdapter<GuidedMcpToolEffectInput, unknown>;
} {
  const normalized = normalizeMcpToolEffectInput(input.args);
  const target = mcpToolEffectTarget(normalized);
  return {
    target,
    input: normalized,
    adapter: createGuidedMcpToolEffectAdapter({
      target,
      executeRegistered: input.executeRegistered,
    }),
  };
}

function createGuidedMcpToolEffectAdapter(input: {
  target: string;
  executeRegistered: ExecuteRegisteredTool;
}): EffectAdapter<GuidedMcpToolEffectInput, unknown> {
  return {
    capability: GUIDED_MCP_TOOL_EFFECT_CAPABILITY,
    reviewedPlanBinding: "accepted_plan",
    normalizeTarget(target) {
      if (target !== input.target) {
        throw new Error("MCP tool target changed after admission");
      }
      return target;
    },
    sanitizeTarget(target) {
      return target;
    },
    normalizeInput: normalizeMcpToolEffectInput,
    async dispatch(effect) {
      if (effect.signal.aborted) {
        return notApplied(
          "mcp_tool_cancelled_before_dispatch",
          "The MCP tool call was cancelled before dispatch.",
        );
      }
      try {
        const result = await input.executeRegistered({
          args: effect.normalizedInput,
          rawArguments: JSON.stringify(effect.normalizedInput),
        });
        return { status: "applied", result };
      } catch (error) {
        return uncertain(
          "mcp_tool_dispatch_uncertain",
          error instanceof Error
            ? error.message
            : "The MCP tool call ended without a reliable response.",
        );
      }
    },
    async reconcile(effect): Promise<EffectReconciliation<unknown>> {
      if (effect.dispatchAttempts === 0) return { status: "not_applied" };
      return {
        status: "uncertain",
        error: {
          code: "mcp_tool_reconciliation_unavailable",
          message: "Generic MCP tools have no safe readback contract; the call will not be repeated automatically.",
        },
      };
    },
  };
}

function normalizeMcpToolEffectInput(value: unknown): GuidedMcpToolEffectInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP tool effect input must be an object");
  }
  const record = value as Record<string, unknown>;
  const arguments_ = record.arguments ?? {};
  if (!arguments_ || typeof arguments_ !== "object" ||
      Array.isArray(arguments_)) {
    throw new Error("MCP tool arguments must be an object");
  }
  return {
    server_id: requiredString(record.server_id, "server_id"),
    tool_name: requiredString(record.tool_name, "tool_name"),
    arguments: arguments_ as Record<string, unknown>,
  };
}

function mcpToolEffectTarget(input: GuidedMcpToolEffectInput): string {
  return `mcp:${input.server_id}/${input.tool_name}`;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`MCP tool ${label} must be a non-empty string`);
  }
  return value.trim();
}

function notApplied(
  code: string,
  message: string,
): EffectDispatchOutcome<unknown> {
  return { status: "not_applied", error: { code, message } };
}

function uncertain(
  code: string,
  message: string,
): EffectDispatchOutcome<unknown> {
  return { status: "uncertain", error: { code, message } };
}
