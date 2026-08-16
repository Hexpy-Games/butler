import { randomUUID } from "node:crypto";
import type { BtccTurnProgressObserver } from "../contracts.ts";
import type { WorkStage } from "../work/index.ts";
import {
  activeWorkActionTitle,
  activityContent,
  activityKind,
  boundedTitle,
  conceptionSummary,
  distinctSummary,
  type GuidedActivityToolCall as ToolCall,
  publicText,
} from "./guided-activity-content.ts";
import { normalizeGuidedToolCall } from "../../tools/tool-support.ts";

export type GuidedActivityBinding = {
  activityId: string;
  displayStage?: WorkStage;
  deferredUntilAccepted: boolean;
};

type ActivityGroup = GuidedActivityBinding & {
  title: string;
  summary: string;
  rationale?: string;
  nextStep?: string;
  precedingGroups?: ActivityGroup[];
  followingGroups?: ActivityGroup[];
  startsExecution?: boolean;
  nextExecutionTitle?: string;
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
  /** Canonical monotonic revision shared by all public Turn activity emitters. */
  nextSourceRevision?: () => number;
}): GuidedActivityProjection {
  let pendingTools: PendingTool[] = [];
  let managed = input.managedInitially === true;
  let localSourceRevision = 0;
  const nextSourceRevision = input.nextSourceRevision ?? (() => ++localSourceRevision);
  const groupsById = new Map<string, ActivityGroup>();
  let currentActivity: ActivityGroup | undefined;
  let fallbackOrdinaryActivity: ActivityGroup | undefined;
  let pendingExecutionTitle: string | undefined;

  return {
    observeToolBatch(batch) {
      pendingTools = pendingBatchTools(batch);
    },

    async observeTool(call) {
      const normalized = normalizeGuidedToolCall({
        toolName: call.name,
        args: call.args,
      });
      const presentationCall = {
        ...call,
        name: normalized.name,
        args: normalized.args,
      };
      const pending = pendingTools.find((candidate) =>
        !candidate.claimed && candidate.name === presentationCall.name,
      ) ?? pendingTools.find((candidate) => !candidate.claimed);
      const kind = activityKind(presentationCall.name);
      const batchHasManagedTool = pendingTools.some((candidate) =>
        activityKind(candidate.name) !== "ordinary",
      );
      let group = pending?.group;
      if (!group && kind === "ordinary") {
        group = currentActivity ?? fallbackOrdinaryActivity;
        if (!group) {
          group = activityGroup({
            text: "",
            calls: [{ name: presentationCall.name, args: presentationCall.args }],
          });
          fallbackOrdinaryActivity = group;
        }
      }
      group ??= activityGroup({
        text: "",
        calls: [{ name: presentationCall.name, args: presentationCall.args }],
      });
      if (pending) pending.claimed = true;
      if (kind !== "ordinary") managed = true;
      if ((managed || batchHasManagedTool) && !group.deferredUntilAccepted) {
        await publishGroup({ ...input, nextSourceRevision }, group);
      }
      return bindingFromGroup(group);
    },

    async markManaged(binding) {
      managed = true;
      const group = binding && groupsById.get(binding.activityId);
      if (group && !group.deferredUntilAccepted) {
        await publishGroup({ ...input, nextSourceRevision }, group);
      }
    },

    async publishAccepted(binding) {
      managed = true;
      const group = groupsById.get(binding.activityId);
      if (group) {
        if (group.deferredUntilAccepted) {
          if (group.startsExecution) {
            pendingExecutionTitle = group.nextExecutionTitle;
            currentActivity = undefined;
          } else {
            currentActivity = group.followingGroups?.at(-1) ?? group;
          }
          fallbackOrdinaryActivity = undefined;
        }
        await publishGroup({ ...input, nextSourceRevision }, group);
      }
    },
  };

  function pendingBatchTools(batch: {
    text: string;
    toolCalls: ToolCall[];
  }): PendingTool[] {
    const tools: PendingTool[] = [];
    const normalizedCalls = batch.toolCalls.map((call) => {
      const normalized = normalizeGuidedToolCall({
        toolName: call.name,
        args: call.args,
      });
      return { ...call, name: normalized.name, args: normalized.args };
    });
    const ordinaryCalls = normalizedCalls.filter(
      (candidate) => activityKind(candidate.name) === "ordinary",
    );
    let ordinaryGroup: ActivityGroup | undefined;
    if (ordinaryCalls.length > 0) {
      if (pendingExecutionTitle) {
        ordinaryGroup = activityGroup({
          text: batch.text,
          calls: ordinaryCalls,
          title: pendingExecutionTitle,
        });
        pendingExecutionTitle = undefined;
        currentActivity = ordinaryGroup;
        fallbackOrdinaryActivity = undefined;
      } else {
        ordinaryGroup = currentActivity ?? fallbackOrdinaryActivity;
        if (!ordinaryGroup) {
          ordinaryGroup = activityGroup({ text: batch.text, calls: ordinaryCalls });
          fallbackOrdinaryActivity = ordinaryGroup;
        }
      }
    }
    for (const call of normalizedCalls) {
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
    title?: string;
  }): ActivityGroup {
    const first = groupInput.calls[0];
    const content = activityContent(first, groupInput.calls, groupInput.text);
    const activeActionTitle = first &&
        (first.name === "record_work_review" ||
          first.name === "record_work_checkpoint")
      ? activeWorkActionTitle(first.args)
      : undefined;
    const commandActivity = first?.name === "run_command" &&
      groupInput.calls.every((call) => call.name === "run_command");
    const group: ActivityGroup = {
      activityId: activityId(input.turnId),
      ...(content.displayStage ? { displayStage: content.displayStage } : {}),
      deferredUntilAccepted: first ? activityKind(first.name) !== "ordinary" : false,
      title: boundedTitle(
        groupInput.title ||
          (first?.name === "record_work_checkpoint" && activeActionTitle) ||
          content.title,
      ),
      summary: commandActivity
        ? content.summary
        : distinctSummary(content.title, content.summary),
      ...(content.rationale ? { rationale: content.rationale } : {}),
      ...(content.nextStep ? { nextStep: content.nextStep } : {}),
      ...(first?.name === "record_work_review" &&
          first.args.subject === "plan" &&
          first.args.verdict === "accept"
        ? {
            startsExecution: true,
            ...(activeActionTitle
              ? { nextExecutionTitle: activeActionTitle }
              : {}),
          }
        : {}),
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
    if (
      first?.name === "record_work_review" &&
      first.args.subject === "completion" &&
      first.args.verdict === "accept"
    ) {
      const reportingDirection = publicText(groupInput.text);
      if (reportingDirection) {
        const reporting: ActivityGroup = {
          activityId: activityId(input.turnId),
          displayStage: "reporting",
          deferredUntilAccepted: group.deferredUntilAccepted,
          title: "결과 보고",
          summary: distinctSummary("결과 보고", reportingDirection),
          published: false,
        };
        group.followingGroups = [reporting];
        groupsById.set(reporting.activityId, reporting);
      }
    }
    groupsById.set(group.activityId, group);
    return group;
  }
}

async function publishGroup(
  input: {
    turnId: string;
    progress?: BtccTurnProgressObserver;
    nextSourceRevision: () => number;
  },
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
      originTurnId: input.turnId,
      sourceRevision: input.nextSourceRevision(),
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
  for (const following of group.followingGroups ?? []) {
    await publishGroup(input, following);
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
