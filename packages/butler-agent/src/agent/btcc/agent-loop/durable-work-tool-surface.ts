import type { DurableWorkView } from "../work/index.ts";
import { availableWorkReviewSubjects } from "../work/index.ts";
import type { BtccAgentLoopToolDefinition } from "./contracts.ts";

const PLAN_BOUND_TOOLS = new Set([
  "record_work_checkpoint",
  "record_work_review",
  "record_work_disposition",
]);

/** Purely narrow model-facing Work inputs from the existing durable snapshot. */
export function projectDurableWorkToolSurface(
  tools: readonly BtccAgentLoopToolDefinition[],
  work: DurableWorkView | undefined,
): BtccAgentLoopToolDefinition[] {
  if (!work?.currentPlan) {
    return tools.filter((tool) => !PLAN_BOUND_TOOLS.has(tool.name));
  }
  const actionKeys = work.currentPlan.actions.map(({ actionKey }) => actionKey);
  const reviewSubjects = availableWorkReviewSubjects(work);
  return tools.map((tool) => {
    if (!PLAN_BOUND_TOOLS.has(tool.name)) return tool;
    const withActionKeys = projectActionKeys(tool, actionKeys);
    return tool.name === "record_work_review"
      ? projectReviewSubjects(withActionKeys, reviewSubjects)
      : withActionKeys;
  });
}

function projectActionKeys(
  tool: BtccAgentLoopToolDefinition,
  actionKeys: readonly string[],
): BtccAgentLoopToolDefinition {
  const properties = objectValue(tool.parameters.properties);
  const updates = objectValue(properties.action_updates);
  const items = objectValue(updates.items);
  const itemProperties = objectValue(items.properties);
  const actionKey = objectValue(itemProperties.action_key);
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...properties,
        action_updates: {
          ...updates,
          items: {
            ...items,
            properties: {
              ...itemProperties,
              action_key: { ...actionKey, enum: [...actionKeys] },
            },
          },
        },
      },
    },
  };
}

function projectReviewSubjects(
  tool: BtccAgentLoopToolDefinition,
  subjects: readonly string[],
): BtccAgentLoopToolDefinition {
  const properties = objectValue(tool.parameters.properties);
  const subject = objectValue(properties.subject);
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...properties,
        subject: { ...subject, enum: [...subjects] },
      },
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Durable Work tool template is invalid");
  }
  return value as Record<string, unknown>;
}
