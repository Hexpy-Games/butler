import { safeOptionalPublicText, safeRelativePath } from "../../../output/evidence/transcript-sanitizers.ts";
import { publicDecisionId } from "../../../output/public-work/protocol.ts";
import type { PublicWorkDecision } from "../output/tool-types.ts";
import type { ActiveTurnContract } from "./turn-contract-runtime.ts";

interface ContinuationToolCall {
  name: string;
  args: Record<string, unknown>;
}

export function createContractContinuationDecision(input: {
  active: ActiveTurnContract;
  toolCalls: readonly ContinuationToolCall[];
  language: "ko" | "en";
  providerRound: number;
}): PublicWorkDecision {
  const boundedCalls = input.toolCalls.slice(0, 6);
  const target = immediateTarget(boundedCalls[0]);
  const batchSuffix = boundedCalls.length > 1
    ? input.language === "ko"
      ? ` 외 ${boundedCalls.length - 1}개 관련 호출`
      : ` plus ${boundedCalls.length - 1} related call(s)`
    : "";
  const targetWithBatch = `${target}${batchSuffix}`;
  const isRead = boundedCalls[0]?.name === "read_file";
  const summary = input.language === "ko"
    ? isRead
      ? `${targetWithBatch} 후보를 읽어 필요한 소스 근거를 확인합니다.`
      : `${targetWithBatch} 범위를 확인해 다음 근거 후보를 정합니다.`
    : isRead
    ? `Read ${targetWithBatch} to verify the required source evidence.`
    : `Inspect ${targetWithBatch} to establish the next evidence candidates.`;
  return {
    decisionId: publicDecisionId(),
    contractId: input.active.contract.contract_id,
    ...(input.active.contract.target_workstream_id
      ? { workstreamId: input.active.contract.target_workstream_id }
      : {}),
    semanticBlockId: `${input.active.contract.contract_id}:block:${input.providerRound}`,
    usageGroupId: `${input.active.contract.contract_id}:round:${input.providerRound}`,
    providerRound: input.providerRound,
    toolBatchSize: boundedCalls.length,
    summary,
    rationale: input.language === "ko"
      ? "이전 블록이 만든 구조화된 후보를 실제 읽기/검사 근거로 전환해야 현재 typed contract를 완료할 수 있습니다."
      : "The previous block produced structured candidates that must become inspected evidence before the typed contract can complete.",
    evidenceRefs: [],
    nextStep: input.language === "ko"
      ? "이번 결과로 근거가 충족되면 최종 답변을 합성하고, 부족하면 새 decision에서 다음 후보 하나를 선택합니다."
      : "If this result satisfies the evidence contract, synthesize the final answer; otherwise select one next candidate in a fresh decision.",
    source: "contract-derived",
    toolName: boundedCalls[0]?.name,
  };
}

function immediateTarget(call: ContinuationToolCall | undefined): string {
  if (!call) return "the selected evidence";
  if (call.name === "read_file") {
    const path = safeRelativePath(call.args.path) ?? "the selected source file";
    const line = positiveInteger(call.args.start_line);
    return line ? `${path}:${line}` : path;
  }
  if (call.name === "grep_files") {
    const pattern = safeOptionalPublicText(call.args.pattern) ?? "the scoped source pattern";
    return `grep_files(${JSON.stringify(pattern)})`;
  }
  const id = safeOptionalPublicText(call.args.id) ?? safeOptionalPublicText(call.args.path);
  return id ? `${call.name}(${id})` : call.name;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}
