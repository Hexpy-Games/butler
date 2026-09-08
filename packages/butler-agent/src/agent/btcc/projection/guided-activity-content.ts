import type { DurableWorkView, WorkStage } from "../work/index.ts";
import { formatInterfaceText, getAppCopy, type InterfaceTextReference, type InterfaceContentReferences } from "../../../../../butler-i18n/src/index.ts";
import { sanitizePublicText } from "../../events/turn-events.ts";
import { isDurableWorkTool } from "../work/index.ts";
import {
  safeCommandActionLabel,
  safeCommandActionIdentity,
  safeFileActionTarget,
} from "../../output/progress/arguments.ts";
import { normalizeGuidedToolCall } from "../../tools/tool-support.ts";
import { publicWorkActionDisplay } from "./work-action-display.ts";

export type GuidedActivityToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export function publicToolTitle(
  name: string,
  args: Record<string, unknown> = {},
  locale: "en-US" | "ko-KR" = "en-US",
): string {
  return formatInterfaceText(publicToolTitleReference(name, args), locale);
}

export function publicToolTitleReference(name: string, args: Record<string, unknown> = {}): InterfaceTextReference {
  if (name === "tool_call") {
    const normalized = normalizeGuidedToolCall({ toolName: name, args });
    if (normalized.name !== name) return publicToolTitleReference(normalized.name, normalized.args);
  }
  let toolName = name;
  if (name.startsWith("project_ledger")) {
    toolName = isProjectLedgerMutation(name) ? "project_ledger_change" : "project_ledger_read";
  }
  if (name === "record_work_review") toolName = args.subject === "plan" ? "plan_review" : args.subject === "completion" ? "completion_review" : name;
  if (!getAppCopy().guided.tools[toolName] && isDurableWorkTool(name)) toolName = "work_tool";
  const target = name === "read_file" || name === "edit_file" || name === "write_file"
    ? safeFileActionTarget(name, args)
    : name === "run_command" ? safeCommandActionLabel(args) : "";
  return { key: "toolTitle", parameters: { toolName, ...(target ? { target } : {}) } };
}

export function activityContent(
  first: GuidedActivityToolCall | undefined,
  calls: GuidedActivityToolCall[],
  assistantText: string,
): {
  displayStage?: WorkStage;
  title: string;
  summary: string;
  rationale?: string;
  nextStep?: string;
  interfaceContent?: InterfaceContentReferences;
} {
  if (first?.name === "start_work" || first?.name === "continue_work") {
    const continuing = first.name === "continue_work";
    return {
      ...(continuing ? {} : { displayStage: "conception" as const }),
      title: publicToolTitle(first.name),
      summary: continuing ? getAppCopy().guided.checkingPrevious : getAppCopy().guided.checkingRequest,
      interfaceContent: { title: publicToolTitleReference(first.name), summary: { key: continuing ? "checkingPrevious" : "checkingRequest" } },
    };
  }
  if (first?.name === "replace_work_plan") {
    const summary = publicText(first.args.objective) || publicText(assistantText) ||
      publicToolTitle(first.name);
    return {
      displayStage: "planning",
      title: publicToolTitle(first.name),
      summary,
      interfaceContent: { title: publicToolTitleReference(first.name), ...(!publicText(first.args.objective) && !publicText(assistantText) ? { summary: publicToolTitleReference(first.name) } : {}) },
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
      interfaceContent: { title: publicToolTitleReference(first.name, first.args), ...(!publicText(first.args.summary) && !publicText(assistantText) ? { summary: publicToolTitleReference(first.name, first.args) } : {}) },
      nextStep: firstCorrection(first.args),
    };
  }
  if (first?.name === "record_work_checkpoint") {
    const summary = publicText(first.args.public_summary) || publicText(assistantText) ||
      publicToolTitle(first.name);
    return {
      displayStage: "execution",
      title: checkpointTitle(),
      summary,
      interfaceContent: { title: publicToolTitleReference(first.name), ...(!publicText(first.args.public_summary) && !publicText(assistantText) ? { summary: publicToolTitleReference(first.name) } : {}) },
      nextStep: publicText(first.args.next_step),
    };
  }

  const titles = calls.map((call) => publicToolTitle(call.name, call.args));
  const toolSummary = ordinaryToolSummary(calls, titles);
  const title = ordinaryActivityTitle(calls, titles);
  const commandLabel = commandActionLabel(calls);
  const authoredSummary = publicText(assistantText);
  const summary = authoredSummary || commandLabel || toolSummary ||
    getAppCopy().guided.toolWorking;
  return {
    title,
    summary: commandLabel && !authoredSummary
      ? summary
      : distinctSummary(title, summary, toolSummary),
    interfaceContent: {
      title: new Set(titles).size === 1 && calls[0] ? publicToolTitleReference(calls[0].name, calls[0].args) : { key: "toolTitle", parameters: { toolName: "tool_work" } },
      ...(!authoredSummary && !commandLabel ? { summary: { key: "toolsSummary" as const, parameters: { tools: calls.map(call => { const ref = publicToolTitleReference(call.name, call.args); return { name: ref.parameters?.toolName ?? "fallback", target: ref.parameters?.target }; }) } } } : {}),
    },
  };
}

/** Presentation of the selected Work, never a new lifecycle transition. */
export function resumedWorkActivity(work: DurableWorkView): {
  displayStage?: WorkStage; title: string; summary: string; interfaceContent?: InterfaceContentReferences;
} {
  const activeKey = work.actionProgress.find((action) => action.status === "active")?.actionKey;
  const activeAction = work.currentPlan?.actions.find((action) => action.actionKey === activeKey);
  const title = activeAction
    ? publicWorkActionDisplay(activeAction, activeAction.description || publicToolTitle("continue_work"))
    : publicToolTitle("continue_work");
  return {
    displayStage: work.currentStage,
    title: boundedTitle(title),
    interfaceContent: activeAction ? undefined : { title: publicToolTitleReference("continue_work") },
    summary: publicText(work.latestCheckpoint?.publicSummary) ||
      publicText(activeAction?.description) || publicText(work.objective),
  };
}

export function activityKind(
  name: string,
): "ordinary" | "work_selection" | "plan" | "review" | "checkpoint" {
  if (name === "start_work" || name === "continue_work") return "work_selection";
  if (name === "replace_work_plan") return "plan";
  if (name === "record_work_review") return "review";
  if (name === "record_work_checkpoint") return "checkpoint";
  return "ordinary";
}

export function publicText(value: unknown): string {
  return sanitizePublicText(value, "").trim();
}

export function conceptionSummary(objective: string): string {
  return getAppCopy().guided.conceptionSummary(objective);
}

export function ordinaryGroupSignature(calls: GuidedActivityToolCall[]): string {
  return [...new Set(calls.map(ordinaryGroupKey))].sort().join("\0");
}

export function ordinaryGroupKey(call: GuidedActivityToolCall): string {
  return call.name === "run_command"
    ? `run_command:${safeCommandActionIdentity(call.args)}`
    : call.name;
}

export function distinctSummary(
  title: string,
  summary: string,
  fallback = getAppCopy().guided.checkingInformation,
): string {
  if (normalizeText(title) !== normalizeText(summary)) return summary;
  if (fallback && normalizeText(title) !== normalizeText(fallback)) return fallback;
  return getAppCopy().guided.workInProgress(summary);
}

export function boundedTitle(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  return [...normalized].slice(0, 32).join("");
}

export function activeWorkActionTitle(
  args: Record<string, unknown>,
): string | undefined {
  if (!Array.isArray(args.action_updates)) return undefined;
  for (const value of args.action_updates) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const update = value as Record<string, unknown>;
    if (update.status !== "active") continue;
    const actionKey = publicText(update.action_key);
    if (!actionKey) continue;
    return publicWorkActionDisplay(
      { actionKey, description: "" },
      actionKey,
    ) || undefined;
  }
  return undefined;
}

function firstPlanAction(args: Record<string, unknown>): string | undefined {
  if (!Array.isArray(args.actions)) return undefined;
  for (const value of args.actions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const action = value as Record<string, unknown>;
    const actionKey = publicText(action.action_key);
    const description = publicText(action.description);
    const effect = action.effect;
    const target = effect && typeof effect === "object" && !Array.isArray(effect) &&
        typeof (effect as Record<string, unknown>).target === "string"
      ? (effect as Record<string, string>).target
      : undefined;
    const text = publicWorkActionDisplay({
      actionKey,
      description,
      ...(target !== undefined ? { effect: { target } } : {}),
    }, description || actionKey);
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
  return publicToolTitle("record_work_review", { subject });
}

function checkpointTitle(): string {
  return publicToolTitle("record_work_checkpoint");
}

export function toolActivitySummary(name: string, title: string): string {
  return getAppCopy().guided.workInProgress(title);
}

function isProjectLedgerMutation(name: string): boolean {
  return /_(?:create|update|complete|archive|restore|delete|index|render)$/u.test(name);
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
  ) return titles[0] || publicToolTitle("run_command");
  if (unique.length === 1) return unique[0] || getAppCopy().guided.tools.tool_work;
  return getAppCopy().guided.tools.tool_work;
}

function ordinaryToolSummary(
  calls: GuidedActivityToolCall[],
  titles: string[],
): string {
  const names = new Set(calls.map((call) => call.name));
  if (names.size === 1 && calls[0]?.name === "run_command") {
    return commandActionLabel(calls) ?? getAppCopy().guided.commandExecuting;
  }
  const grouped = groupedToolLabels(titles);
  return getAppCopy().guided.toolsSummary(grouped);
}

function commandActionLabel(
  calls: GuidedActivityToolCall[],
): string | undefined {
  if (calls.length === 0 || calls.some((call) => call.name !== "run_command")) {
    return undefined;
  }
  return safeCommandActionLabel(calls[0]!.args);
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLocaleLowerCase("ko-KR");
}
