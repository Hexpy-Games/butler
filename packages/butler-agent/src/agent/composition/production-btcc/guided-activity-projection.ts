import { randomUUID } from "node:crypto";
import type { BtccTurnProgressObserver } from "../../btcc/index.ts";
import type { WorkStage } from "../../btcc/durable-work/index.ts";
import { sanitizePublicText } from "../../events/turn-events.ts";
import { publicToolTitle } from "./guided-turn-policy.ts";

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type GuidedActivityBinding = {
  activityId: string;
  displayStage: WorkStage;
  deferredUntilAccepted: boolean;
};

type ActivityGroup = GuidedActivityBinding & {
  title: string;
  summary: string;
  rationale?: string;
  nextStep?: string;
  published: boolean;
};

type PendingTool = {
  name: string;
  claimed: boolean;
  group: ActivityGroup;
};

export interface GuidedActivityProjection {
  observeToolBatch(input: { text: string; toolCalls: ToolCall[] }): void;
  observeTool(input: ToolCall & { effectiveToolName: string }): Promise<GuidedActivityBinding>;
  markManaged(binding?: GuidedActivityBinding): Promise<void>;
  publishAccepted(binding: GuidedActivityBinding): Promise<void>;
  publishFinal(text: string, options: { managed: boolean }): Promise<void>;
}

/**
 * Projects facts from the existing model/tool Turn into public activity blocks.
 * This object owns presentation correlation only; none of its output is read by
 * tool authorization, Work mutation, model retry, or delivery.
 */
export function createGuidedActivityProjection(input: {
  turnId: string;
  progress?: BtccTurnProgressObserver;
  managedInitially?: boolean;
}): GuidedActivityProjection {
  let pendingTools: PendingTool[] = [];
  let managed = input.managedInitially === true;
  const groupsById = new Map<string, ActivityGroup>();

  return {
    observeToolBatch(batch) {
      pendingTools = pendingBatchTools(batch);
    },

    async observeTool(call) {
      const pending = pendingTools.find((candidate) =>
        !candidate.claimed && candidate.name === call.name,
      ) ?? pendingTools.find((candidate) => !candidate.claimed);
      const group = pending?.group ?? activityGroup({
        text: "",
        calls: [{ name: call.name, args: call.args }],
      });
      if (pending) pending.claimed = true;
      if (activityKind(call.name) !== "ordinary") managed = true;
      if (managed && !group.deferredUntilAccepted) await publishGroup(input, group);
      return bindingFromGroup(group);
    },

    async markManaged(binding) {
      managed = true;
      const group = binding && groupsById.get(binding.activityId);
      if (group && !group.deferredUntilAccepted) await publishGroup(input, group);
    },

    async publishAccepted(binding) {
      managed = true;
      const group = groupsById.get(binding.activityId);
      if (group) await publishGroup(input, group);
    },

    async publishFinal(text, options) {
      if (!options.managed && !managed) return;
      const summary = compactTitle(publicText(text));
      if (!summary) return;
      await publishGroup(input, {
        activityId: activityId(input.turnId),
        displayStage: "reporting",
        deferredUntilAccepted: false,
        title: "결과 보고",
        summary,
        published: false,
      });
    },
  };

  function pendingBatchTools(batch: {
    text: string;
    toolCalls: ToolCall[];
  }): PendingTool[] {
    const tools: PendingTool[] = [];
    let ordinaryGroup: ActivityGroup | undefined;
    for (const call of batch.toolCalls) {
      const kind = activityKind(call.name);
      const group = kind === "ordinary"
        ? ordinaryGroup ?? activityGroup({
            text: batch.text,
            calls: batch.toolCalls.filter(
              (candidate) => activityKind(candidate.name) === "ordinary",
            ),
          })
        : activityGroup({ text: batch.text, calls: [call] });
      if (kind === "ordinary") ordinaryGroup = group;
      tools.push({ name: call.name, claimed: false, group });
    }
    return tools;
  }

  function activityGroup(groupInput: {
    text: string;
    calls: ToolCall[];
  }): ActivityGroup {
    const first = groupInput.calls[0];
    const content = activityContent(first, groupInput.calls, groupInput.text);
    const group: ActivityGroup = {
      activityId: activityId(input.turnId),
      displayStage: content.displayStage,
      deferredUntilAccepted: first ? activityKind(first.name) !== "ordinary" : false,
      title: content.title,
      summary: content.summary,
      ...(content.rationale ? { rationale: content.rationale } : {}),
      ...(content.nextStep ? { nextStep: content.nextStep } : {}),
      published: false,
    };
    groupsById.set(group.activityId, group);
    return group;
  }
}

async function publishGroup(
  input: { turnId: string; progress?: BtccTurnProgressObserver },
  group: ActivityGroup,
): Promise<void> {
  if (group.published) return;
  group.published = true;
  if (!input.progress?.phaseActivityChanged) return;
  try {
    await input.progress.phaseActivityChanged({
      turnId: input.turnId,
      semanticState: "admitted",
      activityId: group.activityId,
      displayStage: group.displayStage,
      title: group.title,
      summary: group.summary,
      ...(group.rationale ? { rationale: group.rationale } : {}),
      ...(group.nextStep ? { nextStep: group.nextStep } : {}),
    });
  } catch {
    // Activity projection cannot veto the model/tool Turn.
  }
}

function bindingFromGroup(group: ActivityGroup): GuidedActivityBinding {
  return {
    activityId: group.activityId,
    displayStage: group.displayStage,
    deferredUntilAccepted: group.deferredUntilAccepted,
  };
}

function activityContent(
  first: ToolCall | undefined,
  calls: ToolCall[],
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
      title: compactTitle(summary),
      summary,
      nextStep: firstPlanAction(first.args),
    };
  }
  if (first?.name === "record_work_review") {
    const summary = publicText(first.args.summary) || publicText(assistantText) ||
      publicToolTitle(first.name);
    return {
      displayStage: "review",
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
      title: compactTitle(summary),
      summary,
      nextStep: publicText(first.args.next_step),
    };
  }

  const titles = calls.map((call) => publicToolTitle(call.name));
  const summary = publicText(assistantText) || publicText(titles.join(", ")) ||
    "도구 작업을 진행하고 있습니다";
  return {
    displayStage: "execution",
    title: compactTitle(summary),
    summary,
  };
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
  return subject === "plan" ? "계획 검토" : "결과 검토";
}

function activityKind(name: string): "ordinary" | "plan" | "review" | "checkpoint" {
  if (name === "replace_work_plan") return "plan";
  if (name === "record_work_review") return "review";
  if (name === "record_work_checkpoint") return "checkpoint";
  return "ordinary";
}

function workStage(value: unknown): WorkStage | undefined {
  return value === "conception" || value === "planning" || value === "execution" ||
      value === "review" || value === "reporting"
    ? value
    : undefined;
}

function publicText(value: unknown): string {
  return sanitizePublicText(value, "").trim();
}

function compactTitle(text: string): string {
  const firstSentence = text.split(/(?<=[.!?。！？])\s+/u)[0]?.trim() || text;
  return firstSentence.slice(0, 100);
}

function activityId(turnId: string): string {
  return `guided-activity:${turnId}:${randomUUID()}`;
}
