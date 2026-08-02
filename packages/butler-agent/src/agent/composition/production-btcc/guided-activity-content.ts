import type { WorkStage } from "../../btcc/durable-work/index.ts";
import { sanitizePublicText } from "../../events/turn-events.ts";
import { publicToolTitle } from "./guided-turn-policy.ts";

export type GuidedActivityToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export function activityContent(
  first: GuidedActivityToolCall | undefined,
  calls: GuidedActivityToolCall[],
  assistantText: string,
): {
  displayStage: WorkStage;
  title: string;
  summary: string;
  rationale?: string;
  nextStep?: string;
} {
  if (first?.name === "replace_work_plan") {
    const summary = publicText(first.args.objective) || publicText(assistantText) ||
      publicToolTitle(first.name);
    return {
      displayStage: "planning",
      title: "실행 계획 수립",
      summary,
      nextStep: firstPlanAction(first.args),
    };
  }
  if (first?.name === "record_work_review") {
    const summary = publicText(first.args.summary) || publicText(assistantText) ||
      publicToolTitle(first.name);
    const completionValidation = first.args.subject === "completion";
    return {
      displayStage: completionValidation ? "validation" : "review",
      title: reviewTitle(first.args.subject),
      summary,
      nextStep: firstCorrection(first.args),
    };
  }
  if (first?.name === "record_work_checkpoint") {
    const summary = publicText(first.args.public_summary) || publicText(assistantText) ||
      publicToolTitle(first.name);
    return {
      displayStage: workStage(first.args.next_stage) ?? "execution",
      title: checkpointTitle(first.args.next_stage),
      summary,
      nextStep: publicText(first.args.next_step),
    };
  }

  const titles = calls.map((call) => publicToolTitle(call.name));
  const toolSummary = ordinaryToolSummary(calls, titles);
  const title = ordinaryActivityTitle(calls, titles);
  const summary = publicText(assistantText) || toolSummary ||
    "도구 작업을 진행하고 있습니다";
  return {
    displayStage: "execution",
    title,
    summary: distinctSummary(title, summary, toolSummary),
  };
}

export function activityKind(
  name: string,
): "ordinary" | "plan" | "review" | "checkpoint" {
  if (name === "replace_work_plan") return "plan";
  if (name === "record_work_review") return "review";
  if (name === "record_work_checkpoint") return "checkpoint";
  return "ordinary";
}

export function publicText(value: unknown): string {
  return sanitizePublicText(value, "").trim();
}

export function conceptionSummary(objective: string): string {
  return objective
    ? `요청의 목표와 범위를 확인했습니다: ${objective}`
    : "요청의 목표와 범위를 확인했습니다.";
}

export function ordinaryGroupSignature(calls: GuidedActivityToolCall[]): string {
  return [...new Set(calls.map((call) => call.name))].sort().join("\0");
}

export function distinctSummary(
  title: string,
  summary: string,
  fallback = "작업에 필요한 정보를 확인하고 있습니다.",
): string {
  if (normalizeText(title) !== normalizeText(summary)) return summary;
  if (fallback && normalizeText(title) !== normalizeText(fallback)) return fallback;
  return `${summary} 작업을 진행하고 있습니다.`;
}

export function boundedTitle(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  return [...normalized].slice(0, 32).join("");
}

function firstPlanAction(args: Record<string, unknown>): string | undefined {
  if (!Array.isArray(args.actions)) return undefined;
  for (const value of args.actions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const action = value as Record<string, unknown>;
    const text = publicText(action.description) || publicText(action.action_key);
    if (text) return text;
  }
  return undefined;
}

function firstCorrection(args: Record<string, unknown>): string | undefined {
  if (!Array.isArray(args.corrections)) return undefined;
  for (const value of args.corrections) {
    const text = publicText(value);
    if (text) return text;
  }
  return undefined;
}

function reviewTitle(subject: unknown): string {
  if (subject === "plan") return "계획 검토";
  if (subject === "completion") return "완료 검토";
  return "결과 검토";
}

function workStage(value: unknown): WorkStage | undefined {
  return value === "conception" || value === "planning" || value === "execution" ||
      value === "review" || value === "validation" || value === "reporting"
    ? value
    : undefined;
}

function checkpointTitle(stage: unknown): string {
  if (stage === "conception") return "구상 진행 확인";
  if (stage === "planning") return "계획 진행 확인";
  if (stage === "review") return "리뷰 준비 확인";
  if (stage === "validation") return "검증 진행 확인";
  if (stage === "reporting") return "보고 준비 확인";
  return "작업 진행 확인";
}

function groupedToolLabels(titles: string[]): string {
  return [...new Set(titles)].join(" · ");
}

function ordinaryActivityTitle(
  calls: GuidedActivityToolCall[],
  titles: string[],
): string {
  const unique = [...new Set(titles)];
  if (
    new Set(calls.map((call) => call.name)).size === 1 &&
    calls[0]?.name === "run_command"
  ) return "명령 실행";
  if (unique.length === 1) return unique[0] || "도구 작업";
  return "도구 작업";
}

function ordinaryToolSummary(
  calls: GuidedActivityToolCall[],
  titles: string[],
): string {
  const names = new Set(calls.map((call) => call.name));
  if (names.size === 1 && calls[0]?.name === "run_command") {
    return "작업 공간에서 필요한 명령을 실행하고 있습니다.";
  }
  const grouped = groupedToolLabels(titles);
  return grouped
    ? `${grouped} 도구로 필요한 정보를 확인하고 있습니다.`
    : "필요한 도구로 작업을 진행하고 있습니다.";
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLocaleLowerCase("ko-KR");
}
