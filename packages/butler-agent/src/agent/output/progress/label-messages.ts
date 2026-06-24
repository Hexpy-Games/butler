import type { RuntimeMessageLanguage } from "../messages.ts";
import type { ToolProgressSummary } from "../../turn/native/output/tool-types.ts";

type ToolProgressLabelKey =
  | "inspect_project_status"
  | "query_project_work"
  | "render_project_dashboard"
  | "web_search_with_input"
  | "web_search"
  | "web_read"
  | "summarize_user_profile"
  | "transform_public_data_table"
  | "read_conversation_context"
  | "list_work_streams"
  | "update_work_stream_state"
  | `kind:${ToolProgressSummary["kind"]}`
  | "fallback_with_input"
  | "fallback";

const TOOL_PROGRESS_LABEL_MESSAGES: Record<RuntimeMessageLanguage, Record<ToolProgressLabelKey, string>> = {
  ko: {
    inspect_project_status: "프로젝트 원장 상태를 확인합니다.",
    query_project_work: "프로젝트 원장에서 필요한 작업 맥락을 확인합니다.",
    render_project_dashboard: "프로젝트 원장 대시보드를 갱신합니다.",
    web_search_with_input: "공개 웹에서 \"{inputLabel}\" 관련 정보를 검색합니다.",
    web_search: "공개 웹에서 필요한 정보를 검색합니다.",
    web_read: "선택한 출처의 내용을 확인합니다.",
    summarize_user_profile: "버틀러가 사용자를 어떻게 이해하고 있는지 요약합니다.",
    transform_public_data_table: "수집한 공개 데이터를 표로 정제합니다.",
    read_conversation_context: "이전 대화 맥락에서 필요한 단서를 확인합니다.",
    list_work_streams: "진행 중인 작업 흐름을 확인합니다.",
    update_work_stream_state: "작업 흐름의 상태를 갱신합니다.",
    "kind:dispatch": "필요한 하위 작업을 맡기고 진행 상황을 추적합니다.",
    "kind:edited": "필요한 파일 변경을 적용합니다.",
    "kind:ran_command": "로컬 명령으로 현재 상태를 확인합니다.",
    "kind:searched": "필요한 자료를 검색합니다.",
    "kind:read": "필요한 내용을 읽어 근거를 확인합니다.",
    "kind:context": "필요한 맥락을 확인합니다.",
    "kind:model": "모델 응답을 점검합니다.",
    "kind:used_tool": "작업에 필요한 도구를 사용합니다.",
    fallback_with_input: "필요한 도구 작업을 수행합니다.",
    fallback: "작업에 필요한 도구를 사용합니다.",
  },
  en: {
    inspect_project_status: "Checking the Project Ledger status.",
    query_project_work: "Reviewing the needed Project Ledger work context.",
    render_project_dashboard: "Updating the Project Ledger dashboard.",
    web_search_with_input: "Searching public web sources for {inputLabel}.",
    web_search: "Searching public web sources for the needed information.",
    web_read: "Reading the selected source for evidence.",
    summarize_user_profile: "Summarizing Butler's understanding of the user.",
    transform_public_data_table: "Transforming collected public data into a table.",
    read_conversation_context: "Checking prior conversation context for relevant clues.",
    list_work_streams: "Checking active work streams.",
    update_work_stream_state: "Updating the work stream state.",
    "kind:dispatch": "Delegating the needed subtask and tracking progress.",
    "kind:edited": "Applying the needed file changes.",
    "kind:ran_command": "Checking the current state with a local command.",
    "kind:searched": "Searching for the needed material.",
    "kind:read": "Reading the needed material for evidence.",
    "kind:context": "Checking the needed context.",
    "kind:model": "Reviewing the model response.",
    "kind:used_tool": "Using a tool needed for this task.",
    fallback_with_input: "Running the needed tool work.",
    fallback: "Using a tool needed for this task.",
  },
};

export function toolProgressLabelMessage(
  language: RuntimeMessageLanguage,
  key: ToolProgressLabelKey,
  replacements: { inputLabel?: string } = {},
): string {
  const template = TOOL_PROGRESS_LABEL_MESSAGES[language][key];
  if (!replacements.inputLabel) {
    return template;
  }
  return template.replace("{inputLabel}", replacements.inputLabel);
}
