import { basename } from "node:path";
import { canonicalJson, digest } from "./request-identity.ts";
import type { AuthorityAdmissionInput, AuthorityRecord } from "./contracts.ts";

export type ConversationPermission = {
  grantRef: string; ownerSessionId: string; workspacePath: string;
  scopeKey: string; title: string; description: string; createdAt: string;
};

export function conversationPermissionScope(input: {
  ownerSessionId: string; workspacePath: string; capability: string;
  target: string; normalizedInput: Record<string, unknown>;
  executable?: string;
  publicActionTitle?: string;
}): Omit<ConversationPermission, "createdAt"> {
  const fileEditing = input.capability === "write_file" || input.capability === "edit_file";
  const command = input.capability === "run_command" || input.capability === "run_command_remote_observation";
  const scope = fileEditing ? { kind: "workspace_file_edit" }
    : command ? { kind: "command", command: input.normalizedInput.command, cwd: input.normalizedInput.cwd,
      stateEffect: input.normalizedInput.state_effect }
    : { kind: "effect", capability: input.capability, target: input.target, input: input.normalizedInput };
  const scopeKey = digest(canonicalJson(scope));
  return {
    grantRef: `permission-${digest(canonicalJson([input.ownerSessionId, input.workspacePath, scopeKey])).slice(0, 32)}`,
    ownerSessionId: input.ownerSessionId, workspacePath: input.workspacePath, scopeKey,
    title: fileEditing ? "작업 폴더의 파일 편집" : input.publicActionTitle || (command ? "동일한 명령 실행" : "동일한 작업 실행"),
    description: fileEditing ? `${basename(input.workspacePath)} 안의 파일 쓰기·수정`
      : command ? `${input.executable ?? "명령"} · 허용한 명령·작업 위치에만 적용`
      : "허용한 대상·입력에만 적용",
  };
}

export function permissionForRecord(record: AuthorityRecord) {
  return conversationPermissionScope({ ...record, target: record.normalizedTarget,
    publicActionTitle: record.reason === "Run one reviewed command" || record.reason === "Apply one reviewed effect" ? undefined : record.reason,
    normalizedInput: JSON.parse(record.normalizedInputJson) });
}

export function permissionForAdmission(input: AuthorityAdmissionInput) {
  return conversationPermissionScope({ ...input, normalizedInput: input.normalizedInput });
}
