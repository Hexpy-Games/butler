import type { RuntimeMessageLanguage } from "../messages.ts";
import type { ToolProgressSummary } from "../../tool-support/index.ts";
import { toolProgressLabelMessage } from "./label-messages.ts";

const TOOL_PROGRESS_LABEL_KEYS_BY_NAME = {
  inspect_project_status: "inspect_project_status",
  query_project_work: "query_project_work",
  render_project_dashboard: "render_project_dashboard",
  web_read: "web_read",
  summarize_user_profile: "summarize_user_profile",
  transform_public_data_table: "transform_public_data_table",
  read_conversation_context: "read_conversation_context",
  list_work_streams: "list_work_streams",
  update_work_stream_state: "update_work_stream_state",
} as const;

export function workBlockLabelForTool(
  name: string,
  kind: ToolProgressSummary["kind"],
  inputLabel: string,
  language: RuntimeMessageLanguage,
): string {
  const normalized = name.toLocaleLowerCase("en-US");
  if (normalized === "web_search") {
    const messageKey = inputLabel ? "web_search_with_input" : "web_search";
    return toolProgressLabelMessage(language, messageKey, { inputLabel });
  }
  const nameKey = TOOL_PROGRESS_LABEL_KEYS_BY_NAME[
    normalized as keyof typeof TOOL_PROGRESS_LABEL_KEYS_BY_NAME
  ];
  if (nameKey) {
    return toolProgressLabelMessage(language, nameKey);
  }
  const kindKey = `kind:${kind}` as const;
  if (kind !== "used_tool") {
    return toolProgressLabelMessage(language, kindKey);
  }
  const fallbackKey = inputLabel ? "fallback_with_input" : "fallback";
  return toolProgressLabelMessage(language, fallbackKey);
}
