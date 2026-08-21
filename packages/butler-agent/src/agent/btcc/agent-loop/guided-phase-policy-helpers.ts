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
  const subsession = policy.subsession;
  const allowed = new Set([
    "read_file",
    "list_files",
    "grep_files",
    "web_read",
    "web_search",
    "replace_work_plan",
    "record_work_checkpoint",
    "record_work_review",
    "record_work_disposition",
    ...subsessionToolNames(policy.subsession.allowedToolsAndEffects),
  ]);
  return tools
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => tool.name === "replace_work_plan"
      ? stewardPlanTool(tool, subsession)
      : tool);
}

function stewardPlanTool(
  tool: FunctionToolDefinition,
  subsession: NonNullable<ButlerExecutionPolicy["subsession"]>,
): FunctionToolDefinition {
  const parameters = structuredClone(tool.parameters) as Record<string, unknown>;
  const properties = objectRecord(parameters.properties);
  const actions = objectRecord(properties?.actions);
  const items = objectRecord(actions?.items);
  const actionProperties = objectRecord(items?.properties);
  if (!properties || !actions || !items || !actionProperties || !("effect" in actionProperties)) {
    return tool;
  }
  const boundedActions = {
    ...actions,
    minItems: 2,
  };
  if (subsession.executionMode === "mutation") {
    const effect = objectRecord(actionProperties.effect);
    const effectProperties = objectRecord(effect?.properties);
    const capability = objectRecord(effectProperties?.capability);
    if (!effect || !effectProperties || !capability) return tool;
    const admittedCapabilities = subsessionToolNames(subsession.allowedToolsAndEffects)
      .filter((name) => name === "edit_file" || name === "write_file")
      .sort();
    return {
      ...tool,
      parameters: {
        ...parameters,
        properties: {
          ...properties,
          actions: {
            ...boundedActions,
            description: "Use at least two truthful top-level actions. Any truthful mutation action may carry an admitted edit_file or write_file effect. Inspection, command validation, review, and reporting actions omit effect.",
            items: {
              ...items,
              properties: {
                ...actionProperties,
                effect: {
                  ...effect,
                  properties: {
                    ...effectProperties,
                    capability: {
                      ...capability,
                      description: "Exact admitted native mutation tool name.",
                      enum: admittedCapabilities,
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
  }
  const { effect: _effect, ...withoutEffect } = actionProperties;
  const required = Array.isArray(items.required)
    ? items.required.filter((name) => name !== "effect")
    : items.required;
  return {
    ...tool,
    parameters: {
      ...parameters,
      properties: {
        ...properties,
        actions: {
          ...boundedActions,
          description: "Use at least two truthful top-level evidence actions for this substantial delegated Work.",
          items: {
            ...items,
            properties: withoutEffect,
            required,
          },
        },
      },
    },
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
