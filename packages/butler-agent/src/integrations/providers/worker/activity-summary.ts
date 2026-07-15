import type { RuntimeMessageLanguage } from "../../../agent/output/messages.ts";
import type { WorkerActivityPhase, WorkerActivitySemanticPhase, WorkerActivityUpdate, WorkerActivityWorkBlockUpdate } from "../runtime-contracts.ts";
import { DEFAULT_TOOL_TIMEOUT_MS, MAX_TOOL_TIMEOUT_MS } from "../openai/runtime.ts";
import { formatWorkerEvidenceSubject, readableCommandFiles, safeActivityToken, safeWorkerCommandInputLabel, workerEvidenceSubject } from "./activity-presentation.ts";




export function clampTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TOOL_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_TOOL_TIMEOUT_MS, Math.trunc(value)));
}




export function truncateForLog(text: string, limit = 1_200): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}




export function legacyWorkerActivityPhaseForSemanticPhase(
  semanticPhase: WorkerActivitySemanticPhase,
  fallback: WorkerActivityPhase,
): WorkerActivityPhase {
  switch (semanticPhase) {
    case "verifying":
      return "verifying";
    case "consolidating":
      return "consolidating";
    case "reporting":
      return "reporting";
    case "planning":
    case "orienting":
      return "planning";
    case "executing":
    case "committing":
    case "inspecting":
    case "blocked":
      return fallback;
  }
}




export function applyWorkerActivitySemanticContext(
  update: WorkerActivityUpdate,
  semanticPhase?: WorkerActivitySemanticPhase,
): WorkerActivityUpdate {
  if (!semanticPhase) return update;
  return {
    ...update,
    phase: legacyWorkerActivityPhaseForSemanticPhase(semanticPhase, update.phase),
    semanticPhase,
  };
}




export function summarizeWorkerShellActivity(
  command: string,
  semanticContext: { semanticPhase?: WorkerActivitySemanticPhase } = {},
): WorkerActivityUpdate {
  const normalized = command.toLocaleLowerCase("en-US");
  const withSemanticContext = (update: WorkerActivityUpdate): WorkerActivityUpdate =>
    applyWorkerActivitySemanticContext(update, semanticContext.semanticPhase);
  if (/\bgit\s+(add|commit)\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "committing",
      actionKind: "commit",
      statusLine: "Committing: recording selected work changes.",
    });
  }
  if (/\bgit\s+(status)\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "verifying",
      semanticPhase: "verifying",
      actionKind: "git_status",
      statusLine: "Verifying: checking workspace state.",
    });
  }
  if (/\bgit\s+(diff|show|log)\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "verifying",
      semanticPhase: "verifying",
      actionKind: "git_diff",
      statusLine: "Verifying: checking workspace evidence.",
    });
  }
  if (/(^|&&|;|\|\||\s)(bun|npm|pnpm|yarn)\s+(run\s+)?(test|check|lint|typecheck)(\s|$)/u.test(normalized) || /(^|&&|;|\|\||\s)(vitest|jest|playwright|tsc)(\s|$)/u.test(normalized)) {
    const isTypecheck = /(^|&&|;|\|\||\s)(bun|npm|pnpm|yarn)\s+(run\s+)?typecheck(\s|$)/u.test(normalized) || /(^|&&|;|\|\||\s)tsc(\s|$)/u.test(normalized);
    return withSemanticContext({
      phase: "verifying",
      semanticPhase: "verifying",
      actionKind: isTypecheck ? "typecheck" : "test",
      statusLine: isTypecheck ? "Verifying: running type checks." : "Verifying: running validation checks.",
    });
  }
  if (/\b(apply_patch)\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "executing",
      actionKind: "apply_patch",
      statusLine: "Executing: applying a project patch.",
    });
  }
  if (/\b(cat|python3?|node|bun|perl|ruby|tee)\b/u.test(normalized) && /(>\s*[^&]|write_text|writefilesync|appendfilesync|sed\s+-i)/u.test(command)) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "executing",
      actionKind: "edit_file",
      statusLine: "Executing: writing project files.",
    });
  }
  if (/\b(rg|grep)\b/u.test(normalized) && !/\brg\s+--files\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "inspecting",
      actionKind: "search",
      statusLine: "Inspecting: searching project files.",
    });
  }
  if (/\b(find|ls|tree)\b/u.test(normalized) || /\brg\s+--files\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "inspecting",
      actionKind: "list_files",
      statusLine: "Inspecting: listing project files.",
    });
  }
  if (/\bpwd\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "orienting",
      actionKind: "run_command",
      statusLine: "Orienting: checking the working directory.",
    });
  }
  if (/\bwc\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "inspecting",
      actionKind: "run_command",
      statusLine: "Inspecting: measuring project files.",
    });
  }
  const readableFiles = readableCommandFiles(command);
  if (readableFiles.length > 0) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "inspecting",
      actionKind: "read_file",
      statusLine: `Inspecting: reading ${formatWorkerEvidenceSubject(readableFiles)}.`,
    });
  }
  return withSemanticContext({
    phase: "executing",
    semanticPhase: "executing",
    actionKind: "run_command",
    statusLine: "Executing: running the worker step.",
  });
}




export function summarizeWorkerShellWorkBlock(
  command: string,
  callId: string,
  language: RuntimeMessageLanguage,
  state: "running" | "delivered" | "failed" = "running",
): WorkerActivityWorkBlockUpdate {
  const title = workerCommandActivityTitle(command, language);
  const id = `worker-shell-${safeActivityToken(callId)}`;
  const inputLabel = safeWorkerCommandInputLabel(command);
  const detailLabel = language === "ko" ? "명령" : "Command";
  return {
    id,
    label: title,
    state,
    created_at: new Date().toISOString(),
    rows: [{
      id: `${id}-command`,
      kind: workerCommandProgressKind(command),
      state,
      safe_label: inputLabel ? `Command: ${inputLabel}` : "Command",
      safe_tool_name: "Command",
      safe_input_label: inputLabel,
      tool_call_id: callId,
      work_block_id: id,
      work_block_label: title,
      safe_detail_rows: inputLabel
        ? [{
          id: `${id}-command-detail`,
          kind: "command",
          safe_label: detailLabel,
          safe_value: inputLabel,
          state,
        }]
        : [],
      created_at: new Date().toISOString(),
    }],
  };
}




export function workerActivityUpdateForShellCommand(
  command: string,
  callId: string,
  language: RuntimeMessageLanguage,
  semanticContext: { semanticPhase?: WorkerActivitySemanticPhase } = {},
): WorkerActivityUpdate {
  const activity = summarizeWorkerShellActivity(command, semanticContext);
  const workBlock = summarizeWorkerShellWorkBlock(command, callId, language, "running");
  return {
    ...activity,
    currentTitle: workBlock.label,
    workBlock,
  };
}




export function workerCommandProgressKind(command: string): string {
  const normalized = command.toLocaleLowerCase("en-US");
  if (/\b(test|check|lint|typecheck|vitest|jest|playwright|tsc)\b/u.test(normalized)) return "ran_command";
  if (/\bgit\s+(status|diff|show|log)\b/u.test(normalized)) return "ran_command";
  if (/\b(rg|grep)\b/u.test(normalized) && !/\brg\s+--files\b/u.test(normalized)) return "searched";
  if (/\b(find|ls|tree)\b/u.test(normalized) || /\brg\s+--files\b/u.test(normalized)) return "read";
  if (readableCommandFiles(command).length > 0) return "read";
  return "ran_command";
}




export function workerCommandActivityTitle(command: string, language: RuntimeMessageLanguage): string {
  const normalized = command.toLocaleLowerCase("en-US");
  const readableFiles = readableCommandFiles(command);
  if (language === "ko") {
    if (/\b(test|check|lint|typecheck|vitest|jest|playwright|tsc)\b/u.test(normalized)) {
      return "검증 명령을 실행합니다.";
    }
    if (/\bgit\s+(status|diff|show|log)\b/u.test(normalized)) return "작업 공간 상태를 확인합니다.";
    if (/\b(rg|grep)\b/u.test(normalized) && !/\brg\s+--files\b/u.test(normalized)) {
      return "파일에서 필요한 단서를 검색합니다.";
    }
    if (/\b(find|ls|tree)\b/u.test(normalized) || /\brg\s+--files\b/u.test(normalized)) {
      return "파일 목록을 확인합니다.";
    }
    if (/\bpwd\b/u.test(normalized)) return "작업 디렉터리를 확인합니다.";
    if (/\bwc\b/u.test(normalized)) return "파일 규모를 확인합니다.";
    if (readableFiles.length > 0) return `${formatWorkerEvidenceSubject(readableFiles)} 파일을 읽어 분석합니다.`;
    return "작업 명령을 실행합니다.";
  }
  if (/\b(test|check|lint|typecheck|vitest|jest|playwright|tsc)\b/u.test(normalized)) {
    return "Running validation checks.";
  }
  if (/\bgit\s+(status|diff|show|log)\b/u.test(normalized)) return "Checking workspace state.";
  if (/\b(rg|grep)\b/u.test(normalized) && !/\brg\s+--files\b/u.test(normalized)) {
    return "Searching files for needed evidence.";
  }
  if (/\b(find|ls|tree)\b/u.test(normalized) || /\brg\s+--files\b/u.test(normalized)) {
    return "Checking the file list.";
  }
  if (/\bpwd\b/u.test(normalized)) return "Checking the working directory.";
  if (/\bwc\b/u.test(normalized)) return "Measuring files.";
  if (readableFiles.length > 0) return `Reading ${formatWorkerEvidenceSubject(readableFiles)}.`;
  return "Running the worker command.";
}




export function workerEvidenceActivityTitle(command: string, language: RuntimeMessageLanguage): string {
  const subject = workerEvidenceSubject(command);
  return language === "ko" ? `${subject} 근거를 정리합니다.` : `Reviewing ${subject}.`;
}
