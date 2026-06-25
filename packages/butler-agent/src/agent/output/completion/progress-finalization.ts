import { sanitizePublicText } from "../../events/turn-events.ts";
import type {
  PublicWorkDecision,
  ToolAuditEntry,
} from "../../turn/native/output/tool-types.ts";
import type { RuntimeMessageLanguage } from "../messages.ts";

const MAX_PROGRESS_LINES = 4;

export function progressFinalizationText(input: {
  language: RuntimeMessageLanguage;
  previousAnswer: string;
  audit: ToolAuditEntry[];
  decisions: PublicWorkDecision[];
  reason: string;
}): string {
  const progress = progressLines(input).slice(0, MAX_PROGRESS_LINES);
  const remaining = safeRemainingText(input.reason, input.language);
  if (input.language === "ko") {
    const lines = [
      "진행한 내용은 보존했습니다. 다만 마지막 마무리 단계까지 완전히 닫지는 못했습니다.",
    ];
    if (progress.length > 0) {
      lines.push("", "확인된 진행사항:", ...progress.map((line) => `- ${line}`));
    }
    lines.push(
      "",
      `남은 부분: ${remaining}`,
      "다음 진행에서는 이 지점부터 이어가면 됩니다.",
    );
    return lines.join("\n");
  }
  const lines = [
    "I preserved the work completed so far, but Butler did not fully close the final handoff.",
  ];
  if (progress.length > 0) {
    lines.push("", "Verified progress:", ...progress.map((line) => `- ${line}`));
  }
  lines.push(
    "",
    `Remaining work: ${remaining}`,
    "The next run can continue from this point.",
  );
  return lines.join("\n");
}

function progressLines(input: {
  previousAnswer: string;
  audit: ToolAuditEntry[];
  decisions: PublicWorkDecision[];
  language: RuntimeMessageLanguage;
}): string[] {
  const lines = new Set<string>();
  for (const decision of input.decisions.slice(-4)) {
    const text = safeLine(decision.summary);
    if (text) lines.add(text);
  }
  for (const entry of input.audit.filter((item) => item.ok).slice(-6)) {
    const decision = safeLine(entry.publicDecision?.summary);
    if (decision) {
      lines.add(decision);
      continue;
    }
    const toolLine = toolProgressLine(entry, input.language);
    if (toolLine) lines.add(toolLine);
  }
  const previous = safePreviousAnswerLine(input.previousAnswer);
  if (lines.size === 0 && previous) lines.add(previous);
  return [...lines];
}

function toolProgressLine(entry: ToolAuditEntry, language: RuntimeMessageLanguage): string {
  const result = recordValue(entry.result);
  const refs = safeOutcomeReferences(result).slice(0, 2);
  const toolLabel = publicToolLabel(entry.name, language);
  if (refs.length > 0) {
    return language === "ko"
      ? `${toolLabel} 결과로 ${refs.join(", ")} 상태를 확인했습니다.`
      : `${toolLabel} produced or verified ${refs.join(", ")}.`;
  }
  return language === "ko"
    ? `${toolLabel} 단계를 완료했습니다.`
    : `${toolLabel} completed.`;
}

function publicToolLabel(name: string, language: RuntimeMessageLanguage): string {
  const labels: Record<string, { ko: string; en: string }> = {
    run_command: { ko: "명령 실행", en: "Command execution" },
    write_file: { ko: "파일 작성", en: "File writing" },
    read_file: { ko: "파일 확인", en: "File inspection" },
    grep_files: { ko: "파일 검색", en: "File search" },
  };
  const label = labels[name];
  if (label) return language === "ko" ? label.ko : label.en;
  return language === "ko" ? "작업" : "Work";
}

function safeOutcomeReferences(result: Record<string, unknown> | null): string[] {
  if (!result) return [];
  const values = [
    result.written_file,
    result.artifact_label,
    result.output_label,
    result.file_label,
    result.written_files,
    result.artifact_labels,
    result.verified_output_files,
  ];
  return values
    .flatMap(referenceValues)
    .map(safeLine)
    .filter((line): line is string => Boolean(line));
}

function referenceValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(referenceValues);
  const record = recordValue(value);
  if (record) return [record.path ?? record.label ?? record.artifact_label];
  return [value];
}

function safePreviousAnswerLine(value: string): string | null {
  const firstLine = value.split(/\r?\n/u)
    .map((line) => line.replace(/^[-*]\s*/u, "").trim())
    .find((line) => line && !/^INCOMPLETE:/iu.test(line));
  return safeLine(firstLine);
}

function safeRemainingText(reason: string, language: RuntimeMessageLanguage): string {
  if (isInternalProtocolText(reason)) {
    return language === "ko"
      ? "완료 보고에 필요한 마지막 결과 정리가 남아 있습니다."
      : "The final result summary still needs to be closed.";
  }
  return safeLine(reason) ?? (language === "ko"
    ? "완료 보고에 필요한 마지막 결과 정리가 남아 있습니다."
    : "The final result summary still needs to be closed.");
}

function isInternalProtocolText(value: string): boolean {
  return /completion obligation|durable_artifact|data_table_created|chart_rendered|source_verified|command_executed|INCOMPLETE:/iu
    .test(value);
}

function safeLine(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (isInternalProtocolText(value)) return null;
  const safe = sanitizePublicText(value, "");
  return safe ? safe.slice(0, 180) : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
