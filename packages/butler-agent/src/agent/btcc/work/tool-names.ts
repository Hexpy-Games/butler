export const DURABLE_WORK_TOOL_NAMES = [
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
