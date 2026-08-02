import { randomUUID } from "node:crypto";
import type { BtccTurnProgressObserver } from "../../btcc/index.ts";
import type { WorkStage } from "../../btcc/durable-work/index.ts";
import {
  activityContent,
  activityKind,
  boundedTitle,
  conceptionSummary,
  distinctSummary,
  type GuidedActivityToolCall as ToolCall,
  ordinaryGroupSignature,
  publicText,
} from "./guided-activity-content.ts";

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
  precedingGroups?: ActivityGroup[];
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
  publishFinal(text: string, options: {
    managed: boolean;
    completed?: boolean;
    completionValidated?: boolean;
    currentStage?: WorkStage;
  }): Promise<void>;
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
  let lastEmptyOrdinaryGroup:
    | { signature: string; group: ActivityGroup }
    | undefined;

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
      const summary = publicText(text);
      if (!summary) return;
      const completed = options.completed === true &&
        options.completionValidated === true;
      await publishGroup(input, {
        activityId: activityId(input.turnId),
        displayStage: completed
          ? "reporting"
          : openFinalStage(options.currentStage),
        deferredUntilAccepted: false,
        title: completed ? "결과 보고" : "부분 결과 안내",
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
    const ordinaryCalls = batch.toolCalls.filter(
      (candidate) => activityKind(candidate.name) === "ordinary",
    );
    const emptyOrdinaryBatch = !publicText(batch.text) &&
      ordinaryCalls.length === batch.toolCalls.length;
    const signature = ordinaryGroupSignature(ordinaryCalls);
    const ordinaryGroup = emptyOrdinaryBatch &&
        lastEmptyOrdinaryGroup?.signature === signature
      ? lastEmptyOrdinaryGroup.group
      : ordinaryCalls.length > 0
      ? activityGroup({ text: batch.text, calls: ordinaryCalls })
      : undefined;
    lastEmptyOrdinaryGroup = emptyOrdinaryBatch && ordinaryGroup
      ? { signature, group: ordinaryGroup }
      : undefined;
    for (const call of batch.toolCalls) {
      const kind = activityKind(call.name);
      const group = kind === "ordinary"
        ? ordinaryGroup ?? activityGroup({ text: batch.text, calls: [call] })
        : activityGroup({ text: batch.text, calls: [call] });
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
      title: boundedTitle(content.title),
      summary: distinctSummary(content.title, content.summary),
      ...(content.rationale ? { rationale: content.rationale } : {}),
      ...(content.nextStep ? { nextStep: content.nextStep } : {}),
      published: false,
    };
    if (first?.name === "replace_work_plan") {
      const conception: ActivityGroup = {
        activityId: activityId(input.turnId),
        displayStage: "conception",
        deferredUntilAccepted: group.deferredUntilAccepted,
        title: "요청 의도 확인",
        summary: conceptionSummary(content.summary),
        nextStep: "요청에 맞는 작업 순서와 검증 기준을 정합니다.",
        published: false,
      };
      group.precedingGroups = [conception];
      groupsById.set(conception.activityId, conception);
    }
    groupsById.set(group.activityId, group);
    return group;
  }
}

function openFinalStage(stage: WorkStage | undefined): WorkStage {
  return stage ?? "execution";
}

async function publishGroup(
  input: { turnId: string; progress?: BtccTurnProgressObserver },
  group: ActivityGroup,
): Promise<void> {
  if (group.published) return;
  for (const preceding of group.precedingGroups ?? []) {
    await publishGroup(input, preceding);
  }
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

function activityId(turnId: string): string {
  return `guided-activity:${turnId}:${randomUUID()}`;
}
