import type { StewardResultView } from
  "../../../../gateways/app/interface/protocol/app-protocol.ts";
import { projectBtccFinalContentSummary } from "../../../btcc/index.ts";
import { recoverLegacyTruncatedReport } from "./subsession-result-record.ts";

const LEGACY_STEWARD_FAILURE_SUMMARY = "Steward could not complete the bounded task.";

export function publicStewardTerminalFields(input: {
  status: StewardResultView["status"];
  code: StewardResultView["code"];
  summary: string;
  workStatus: string | null;
  finalPayloadJson: string | null;
}): Pick<StewardResultView, "status" | "code" | "summary"> {
  if (input.summary !== LEGACY_STEWARD_FAILURE_SUMMARY) {
    return { status: input.status, code: input.code ?? null,
      summary: recoverLegacyTruncatedReport(input.summary, input.finalPayloadJson) };
  }
  const status = input.workStatus === "completed"
    ? "success"
    : input.workStatus === "blocked"
      ? "blocked"
      : input.status;
  return {
    status,
    code: status === "success" || status === "blocked" ? null : input.code ?? null,
    summary: finalPayloadSummary(input.finalPayloadJson) ?? "이전 작업 결과 기록입니다.",
  };
}

function finalPayloadSummary(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const content = (JSON.parse(raw) as { content?: unknown }).content;
    return typeof content === "string" && content.trim()
      ? projectBtccFinalContentSummary(content)
      : null;
  } catch {
    return null;
  }
}
