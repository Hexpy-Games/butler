import { BUTLER_TOOLS } from "../../tools/butler-tools.ts";
import { TOOL_CAPABILITY_METADATA } from "../../tools/registry.ts";
import type { ButlerExecutionPolicy } from "../contracts.ts";
import type { FunctionToolDefinition } from "../../../integrations/providers/runtime-contracts.ts";
import { DURABLE_WORK_TOOL_DEFINITIONS } from "./durable-work-tools.ts";
import { subsessionToolNames } from "../subsessions/scope.ts";

export function boundedStewardTools(
  policy: Pick<ButlerExecutionPolicy, "role" | "subsession">,
  tools: readonly FunctionToolDefinition[],
): FunctionToolDefinition[] {
  if (policy.role !== "steward" || !policy.subsession) return [...tools];
  const allowed = new Set([
    "read_file",
    "list_files",
    "grep_files",
    "replace_work_plan",
    "record_work_review",
    "record_work_disposition",
    ...subsessionToolNames(policy.subsession.allowedToolsAndEffects),
  ]);
  return tools.filter((tool) => allowed.has(tool.name));
}

export function phaseAllowsTool(
  phase: "direct" | "read_only" | "execution",
  tool: FunctionToolDefinition,
): boolean {
  if (phase === "execution") return true;
  const capability = TOOL_CAPABILITY_METADATA[tool.name];
  if (phase === "direct") {
    const native = BUTLER_TOOLS.find((candidate) => candidate.name === tool.name);
    return native?.effectBoundary === "none" &&
      capability?.category !== "project" && capability?.category !== "command" &&
      capability?.category !== "file" && capability?.category !== "work";
  }
  if (DURABLE_WORK_TOOL_DEFINITIONS.some((candidate) => candidate.name === tool.name)) return false;
  const native = BUTLER_TOOLS.find((candidate) => candidate.name === tool.name);
  return native?.effectBoundary === "none";
}

export function removeRuntimeOwnedSchemaDefaults(
  tool: FunctionToolDefinition,
): FunctionToolDefinition {
  return {
    ...tool,
    parameters: removeSchemaDefaults(tool.parameters) as Record<string, unknown>,
  };
}

function removeSchemaDefaults(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeSchemaDefaults);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "default")
      .map(([key, nested]) => [key, removeSchemaDefaults(nested)]),
  );
}
