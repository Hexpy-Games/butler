import type { MessageRecord, SessionView } from "../../packages/butler-app/client/ui/src/app/types";
import { initiatedMessage, session } from "./initiated-fixtures";

export const workSessionId = "work-research-42";
// Synthetic credential, never a usable secret.
export const commandCredential = "example-credential-value";
export const exactCommand = `curl -H 'Authorization: Bearer ${commandCredential}' https://example.com/report`;
export const maskedCommand = "curl -H 'Authorization: Bearer ••••' https://example.com/report";
export const canonDescription = "조사 내용을 모아 검토합니다.";
export const workTitle = "주간 조사 정리";
export const canonTitle = { epic: "조사 자료 정리", plan: "11월 조사 계획" };
export const projectTitle = "연구 프로젝트";
export const planTitle = "가을 조사";
export const dueOn = "2026-11-30";

export function workResult(en = false, documents = true): MessageRecord {
  const report = initiatedMessage("report");
  return { ...report, id: "work-result", text: en ? "The research is ready. The details are in the document." : "조사를 마쳤어요. 자세한 내용은 문서로 드릴게요.",
    artifacts: documents ? report.artifacts : [],
    initiated: { kind: "work_result", quiet: false, relation_id: "relation-42", work_session_id: workSessionId, work_title: workTitle } };
}
export function approvalNeeded(child = false, label?: string): MessageRecord {
  return { ...initiatedMessage("report"), id: "approval-needed", artifacts: [], text: "Stored notification text",
    initiated: { kind: "approval_needed", quiet: false, label, automation_id: "schedule-1", automation_title: "환율·미국 증시 정리", run_id: "run-42",
      ...(child ? { work_session_id: workSessionId } : {}),
      approval: { action_kind: "run_command", targets: [{ kind: "folder", path: "research" }], count: 1,
        examples: [exactCommand], risk: "medium", operation: { tool: "exec_command", access: "change", targets: [], command: exactCommand } } } };
}
export function canonApproval(kind: "epic" | "plan", description = canonDescription): SessionView {
  return { ...session([]), authority_requests: [{ request_ref: `canon-${kind}`, category: "reviewed_effect", reason: "Create a board item", executable: "canon_propose", command_count: 1,
    approval: { action_kind: "create_canon", targets: [{ kind: "project", path: "project-research" }], count: 1, examples: [], risk: "low",
      operation: { tool: "canon_propose", access: "change", targets: ["project-research"] },
      canon: { kind, description, title: canonTitle[kind], project_id: "project-research", project_title: projectTitle,
        ...(kind === "epic" ? { plan_id: "plan-autumn", plan_title: planTitle } : { due_on: dueOn }) } } }] };
}

export function commandApproval(): SessionView {
  return { ...session([]), authority_requests: [{ request_ref: "command-review", category: "reviewed_effect",
    reason: "Run command", executable: "exec_command", command_count: 1, approval: approvalNeeded().initiated!.approval }] };
}

export const longEditPath = "/workspace/projects/research/quarterly-reports/supporting-documents/source-material/notes.txt";
export function longPathApproval(): SessionView {
  return { ...session([]), authority_requests: [{ request_ref: "long-path-review", category: "reviewed_effect",
    reason: "Edit file", executable: "edit_files", command_count: 1,
    approval: { action_kind: "edit_files", targets: [{ kind: "folder", path: longEditPath, label: longEditPath }],
      count: 1, examples: [], risk: "low", operation: { tool: "edit_files", access: "change", targets: [longEditPath] } } }] };
}

export function workFailed(en = false, retrying = false, chatId = "general", reasonCode = "hook_blocked"): MessageRecord {
  return { ...workResult(en, false), id: "work-failed", chat_id: chatId, text: "Stored notification text",
    initiated: { kind: "work_failed", quiet: false, work_session_id: workSessionId, work_title: workTitle,
      state: retrying ? "retrying" : "failed", reason_code: reasonCode } };
}
