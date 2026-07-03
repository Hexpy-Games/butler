import { publicDecisionId } from "../../../output/public-work/protocol.ts";
import type { PublicWorkDecision } from "../output/tool-types.ts";
import type { NativeAuditedToolExecutorInput, NativeToolCall } from "./audited-executor-types.ts";

const LEDGER_PREFLIGHT_TOOL_NAMES = new Set([
  "project_ledger_status",
  "project_ledger_list",
  "project_ledger_show",
  "project_ledger_check",
  "inspect_project_status",
  "query_project_work",
]);

export function allowsProjectLedgerPreflightDecision(input: {
  executorInput: NativeAuditedToolExecutorInput;
  call: NativeToolCall;
}): boolean {
  if (!LEDGER_PREFLIGHT_TOOL_NAMES.has(input.call.name)) return false;
  if (!ledgerTrackingMode(input.executorInput.turnInput.metadata)) return false;
  const currentToolNames = input.executorInput.toolSurfaceController?.currentToolNames() ?? [];
  return currentToolNames.includes(input.call.name) && currentToolNames.includes("project_ledger_status");
}

export function createProjectLedgerPreflightDecision(input: {
  toolName: string;
}): PublicWorkDecision {
  const action = input.toolName === "query_project_work"
    ? "Project Ledger 작업 맥락을 canonical 도구로 조회합니다."
    : "Project Ledger 상태를 canonical 도구로 확인합니다.";
  return {
    decisionId: publicDecisionId(),
    summary: action,
    rationale: "Ledger 프로젝트 세션은 원천 파일이나 셸 우회가 아니라 전용 Ledger 도구 결과를 기준으로 상태를 판단해야 합니다.",
    evidenceRefs: [],
    nextStep: "조회 결과를 기준으로 다음 작업 순서와 남은 상태를 정리합니다.",
    completionObligations: ["source_verified"],
    source: "runtime-derived",
    toolName: input.toolName,
  };
}

function ledgerTrackingMode(metadata: Record<string, unknown> | undefined): boolean {
  const runtimePolicy = objectRecord(metadata?.runtimePolicy);
  return metadata?.trackingMode === "ledger" ||
    metadata?.tracking_mode === "ledger" ||
    runtimePolicy.trackingMode === "ledger" ||
    runtimePolicy.tracking_mode === "ledger";
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
