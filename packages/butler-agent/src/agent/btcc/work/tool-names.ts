export const DURABLE_WORK_TOOL_NAMES = [
  "start_work",
  "continue_work",
  "replace_work_plan",
  "record_work_checkpoint",
  "record_work_review",
  "record_work_disposition",
] as const;

export type DurableWorkToolName = typeof DURABLE_WORK_TOOL_NAMES[number];

const DURABLE_WORK_TOOL_NAME_SET = new Set<string>(DURABLE_WORK_TOOL_NAMES);

export function isDurableWorkTool(name: string): name is DurableWorkToolName {
  return DURABLE_WORK_TOOL_NAME_SET.has(name);
}

export function isWorkRelationshipTool(name: string): name is
  | "start_work"
  | "continue_work" {
  return name === "start_work" || name === "continue_work";
}
