import type { FunctionToolDefinition } from
  "../../../integrations/providers/runtime-contracts.ts";
import type {
  ButlerToolCall,
  ButlerToolExecutor,
} from "../../tools/butler-tools.ts";
import { normalizeGuidedToolCall } from
  "../../tools/tool-call-normalization.ts";
import { isProjectLedgerPlanMutation } from "../project-plan.ts";
import { toolResultSucceeded } from "./guided-tool-progress.ts";
import {
  effectiveToolNameForCall,
  guidedNativeToolDefinitions,
} from "./guided-turn-policy.ts";

export function projectPlanModeTools(input: {
  tools: readonly FunctionToolDefinition[];
  exactResultRead: boolean;
  planId?: string;
}): FunctionToolDefinition[] {
  const mutationName = input.planId ? "project_ledger_update" : "project_ledger_create";
  const nativeTools = guidedNativeToolDefinitions(input.exactResultRead);
  const visible = new Set(
    nativeTools
      .filter((tool) => tool.effectBoundary === "none" || tool.name === mutationName)
      .map((tool) => tool.name),
  );
  const tools = new Map(
    input.tools
      .filter((tool) => visible.has(tool.name))
      .map((tool) => [tool.name, tool]),
  );
  const mutation = nativeTools.find((tool) => tool.name === mutationName);
  if (mutation) tools.set(mutation.name, mutation);
  return [...tools.values()];
}

export function createProjectPlanModeExecution(input: {
  enabled: boolean;
  planId?: string;
  executeTool: ButlerToolExecutor;
}): {
  allowDirectPersistentEffect: (call: ButlerToolCall) => boolean;
  executeTool: ButlerToolExecutor;
  completed: () => boolean;
} {
  let mutationInFlight = false;
  let mutationCompleted = false;
  const allowedMutation = (call: ButlerToolCall) => input.enabled &&
    isAllowedProjectPlanMutation(call, input.planId);
  return {
    allowDirectPersistentEffect: allowedMutation,
    completed: () => mutationCompleted,
    executeTool: async (call) => {
      if (!allowedMutation(call)) return await input.executeTool(call);
      if (mutationInFlight || mutationCompleted) {
        return {
          ok: false,
          error: {
            code: "plan_mutation_already_completed",
            message: "Plan mode permits one successful Project Ledger Plan mutation per Turn.",
          },
        };
      }
      mutationInFlight = true;
      try {
        const result = await input.executeTool(call);
        if (toolResultSucceeded(result)) mutationCompleted = true;
        return result;
      } finally {
        mutationInFlight = false;
      }
    },
  };
}

export function isAllowedProjectPlanMutation(
  call: ButlerToolCall,
  planId?: string,
): boolean {
  const normalized = normalizedPlanCall(call);
  if (!normalized || normalized.args.kind !== "plan") return false;
  if (planId) {
    return normalized.name === "project_ledger_update" &&
      normalized.args.id === planId &&
      (normalized.args.status === "draft" || normalized.args.status === "active");
  }
  return normalized.name === "project_ledger_create" &&
    normalized.args.status === "draft";
}

function normalizedPlanCall(call: ButlerToolCall): {
  name: string;
  args: Record<string, unknown>;
} | null {
  const name = effectiveToolNameForCall(call.name, call.args);
  if (!isProjectLedgerPlanMutation(name)) return null;
  return normalizeGuidedToolCall({ toolName: name, args: call.args });
}
