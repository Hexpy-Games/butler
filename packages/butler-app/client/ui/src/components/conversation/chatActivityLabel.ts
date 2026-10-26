import { appCopy } from "@/app/copy.ts";
import type { PhaseActivity } from "@/app/conversation-progress";
import { toolchainGroupLabel } from "./toolchainUtils";
import { isWorkActivityToolRow } from "./workActivityToolRow";

/**
 * 대화's live status in place of its activity timeline: the newest tool of the current activity,
 * named from the tool-label map, with the count the timeline's tool group shows for it.
 */
export function chatActivityLabel(activities: PhaseActivity[]): string | undefined {
  const tools = (activities.at(-1)?.operations ?? []).filter(row => isWorkActivityToolRow(row) && !row.thinking_title);
  const latest = tools.filter(row => row.safe_tool_name).at(-1);
  if (!latest?.safe_tool_name) return undefined;
  const label = appCopy.guided.tools[latest.safe_tool_name];
  if (!label) return appCopy.guided.tools.fallback;
  const group = toolchainGroupLabel(latest);
  return appCopy.interfaceTemplates.chatActivity(label, tools.filter(row => toolchainGroupLabel(row) === group).length);
}
