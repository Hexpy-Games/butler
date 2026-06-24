import type { RuntimeMessageLanguage } from "../messages.ts";
import type { ToolProgressSummary } from "../../turn/native/output/tool-types.ts";

export function workBlockLabelForTool(
  name: string,
  kind: ToolProgressSummary["kind"],
  inputLabel: string,
  language: RuntimeMessageLanguage,
): string {
  const normalized = name.toLocaleLowerCase("en-US");
  if (language === "ko") {
    if (normalized === "inspect_project_status") return "프로젝트 원장 상태를 확인합니다.";
    if (normalized === "query_project_work") return "프로젝트 원장에서 필요한 작업 맥락을 확인합니다.";
    if (normalized === "render_project_dashboard") return "프로젝트 원장 대시보드를 갱신합니다.";
    if (normalized === "web_search") {
      return inputLabel
        ? `공개 웹에서 "${inputLabel}" 관련 정보를 검색합니다.`
        : "공개 웹에서 필요한 정보를 검색합니다.";
    }
    if (normalized === "web_read") return "선택한 출처의 내용을 확인합니다.";
    if (normalized === "summarize_user_profile") return "버틀러가 사용자를 어떻게 이해하고 있는지 요약합니다.";
    if (normalized === "transform_public_data_table") return "수집한 공개 데이터를 표로 정제합니다.";
    if (normalized === "read_conversation_context") return "이전 대화 맥락에서 필요한 단서를 확인합니다.";
    if (normalized === "list_work_streams") return "진행 중인 작업 흐름을 확인합니다.";
    if (normalized === "update_work_stream_state") return "작업 흐름의 상태를 갱신합니다.";
    if (kind === "dispatch") return "필요한 하위 작업을 맡기고 진행 상황을 추적합니다.";
    if (kind === "edited") return "필요한 파일 변경을 적용합니다.";
    if (kind === "ran_command") return "로컬 명령으로 현재 상태를 확인합니다.";
    if (kind === "searched") return "필요한 자료를 검색합니다.";
    if (kind === "read") return "필요한 내용을 읽어 근거를 확인합니다.";
    return inputLabel ? "필요한 도구 작업을 수행합니다." : "작업에 필요한 도구를 사용합니다.";
  }
  if (normalized === "inspect_project_status") return "Checking the Project Ledger status.";
  if (normalized === "query_project_work") return "Reviewing the needed Project Ledger work context.";
  if (normalized === "render_project_dashboard") return "Updating the Project Ledger dashboard.";
  if (normalized === "web_search") {
    return inputLabel
      ? `Searching public web sources for ${inputLabel}.`
      : "Searching public web sources for the needed information.";
  }
  if (normalized === "web_read") return "Reading the selected source for evidence.";
  if (normalized === "summarize_user_profile") return "Summarizing Butler's understanding of the user.";
  if (normalized === "transform_public_data_table") return "Transforming collected public data into a table.";
  if (normalized === "read_conversation_context") return "Checking prior conversation context for relevant clues.";
  if (normalized === "list_work_streams") return "Checking active work streams.";
  if (normalized === "update_work_stream_state") return "Updating the work stream state.";
  if (kind === "dispatch") return "Delegating the needed subtask and tracking progress.";
  if (kind === "edited") return "Applying the needed file changes.";
  if (kind === "ran_command") return "Checking the current state with a local command.";
  if (kind === "searched") return "Searching for the needed material.";
  if (kind === "read") return "Reading the needed material for evidence.";
  return inputLabel ? "Running the needed tool work." : "Using a tool needed for this task.";
}
