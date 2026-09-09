import { randomUUID } from "node:crypto";
import { getAppCopy, type InterfaceContentReferences } from "../../../../../butler-i18n/src/index.ts";
import type { BtccTurnProgressObserver } from "../contracts.ts";
import type { DurableWorkView, WorkStage } from "../work/index.ts";
import {
  activeWorkActionTitle,
  activityContent,
  activityKind,
  boundedTitle,
  conceptionSummary,
  distinctSummary,
  type GuidedActivityToolCall as ToolCall,
  publicText,
  resumedWorkActivity,
} from "./guided-activity-content.ts";
import { normalizeGuidedToolCall } from "../../tools/tool-support.ts";

export type GuidedActivityBinding = {
  activityId: string;
  displayStage?: WorkStage;
  deferredUntilAccepted: boolean;
};

type ActivityGroup = GuidedActivityBinding & {
  interfaceContent?: InterfaceContentReferences;
  title: string;
  summary: string;
  rationale?: string;
  nextStep?: string;
  precedingGroups?: ActivityGroup[];
  followingGroups?: ActivityGroup[];
  startsExecution?: boolean;
  resumesWork?: boolean;
  nextExecutionTitle?: string;
  published: boolean;
};

type PendingTool = {
  name: string;
  claimed: boolean;
  group: ActivityGroup;
};

export type GuidedActivitySnapshot = {
  groups: Array<Omit<ActivityGroup, "precedingGroups" | "followingGroups"> & {
    precedingIds?: string[];
    followingIds?: string[];
  }>;
  pendingTools: Array<{ name: string; claimed: boolean; groupId: string }>;
  toolBindings: Array<[string, GuidedActivityBinding]>;
  managed: boolean;
  currentActivityId?: string;
  fallbackActivityId?: string;
  pendingExecutionTitle?: string;
  pendingExecution?: boolean;
  pendingStage?: WorkStage;
};

export interface GuidedActivityProjection {
  observeToolBatch(input: { text: string; toolCalls: ToolCall[] }): void;
  observeTool(input: ToolCall & { effectiveToolName: string; callId?: string }): Promise<GuidedActivityBinding>;
  publishAccepted(binding: GuidedActivityBinding, work?: DurableWorkView | null): Promise<void>;
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
  initialWork?: DurableWorkView;
  /** Canonical monotonic revision shared by all public Turn activity emitters. */
  nextSourceRevision?: () => number;
  restored?: GuidedActivitySnapshot;
}): GuidedActivityProjection & { snapshot(): GuidedActivitySnapshot } {
  let pendingTools: PendingTool[] = [];
  let managed = input.managedInitially === true;
  let localSourceRevision = 0;
  const nextSourceRevision = input.nextSourceRevision ?? (() => ++localSourceRevision);
  const groupsById = new Map<string, ActivityGroup>();
  const toolBindings = new Map(input.restored?.toolBindings ?? []);
  let currentActivity: ActivityGroup | undefined;
  let fallbackOrdinaryActivity: ActivityGroup | undefined;
  let pendingExecutionTitle = input.initialWork ? resumedWorkActivity(input.initialWork).title : undefined;
  let pendingStage = input.initialWork?.currentStage;
  if (input.restored) {
    const restored = input.restored;
    managed = restored.managed;
    for (const { precedingIds: _before, followingIds: _after, ...group } of restored.groups) {
      groupsById.set(group.activityId, { ...group });
    }
    for (const group of restored.groups) {
      const target = groupsById.get(group.activityId)!;
      target.precedingGroups = group.precedingIds?.map((id) => groupsById.get(id)!);
      target.followingGroups = group.followingIds?.map((id) => groupsById.get(id)!);
    }
    pendingTools = restored.pendingTools.map(({ groupId, ...tool }) => ({
      ...tool, group: groupsById.get(groupId)!,
    }));
    currentActivity = groupsById.get(restored.currentActivityId ?? "");
    fallbackOrdinaryActivity = groupsById.get(restored.fallbackActivityId ?? "");
    pendingExecutionTitle = restored.pendingExecutionTitle;
    pendingStage = restored.pendingStage ??
      ((restored.pendingExecution ?? Boolean(restored.pendingExecutionTitle)) ? "execution" : undefined);
  }

  return {
    snapshot() {
      return {
        managed, pendingExecutionTitle, pendingStage,
        toolBindings: [...toolBindings],
        currentActivityId: currentActivity?.activityId,
        fallbackActivityId: fallbackOrdinaryActivity?.activityId,
        groups: [...groupsById.values()].map(({ precedingGroups, followingGroups, ...group }) => ({
          ...group,
          precedingIds: precedingGroups?.map((item) => item.activityId),
          followingIds: followingGroups?.map((item) => item.activityId),
        })),
        pendingTools: pendingTools.map(({ group, ...tool }) => ({ ...tool, groupId: group.activityId })),
      };
    },
    observeToolBatch(batch) {
      pendingTools = pendingBatchTools(batch);
    },

    async observeTool(call) {
      const existing = call.callId ? toolBindings.get(call.callId) : undefined;
      if (existing) return existing;
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
      group ??= activityGroup({
        text: "",
        calls: [{ name: presentationCall.name, args: presentationCall.args }],
      });
      if (kind === "ordinary") group = ordinaryActivity(group);
      if (pending) pending.claimed = true;
      if (kind !== "ordinary") managed = true;
      if ((managed || batchHasManagedTool) && !group.deferredUntilAccepted) {
        await publishGroup({ ...input, nextSourceRevision }, group);
      }
      const binding = bindingFromGroup(group);
      if (call.callId) toolBindings.set(call.callId, binding);
      return binding;
    },

    async publishAccepted(binding, work) {
      managed = true;
      const group = groupsById.get(binding.activityId);
      if (group) {
        if (group.resumesWork && work) {
          Object.assign(group, resumedWorkActivity(work));
          binding.displayStage = group.displayStage;
        }
        if (group.startsExecution) {
          pendingStage = "execution";
          pendingExecutionTitle = group.nextExecutionTitle;
          currentActivity = undefined;
        } else {
          pendingStage = undefined;
          pendingExecutionTitle = undefined;
          currentActivity = group.followingGroups?.at(-1) ?? group;
        }
        fallbackOrdinaryActivity = undefined;
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
    for (const call of normalizedCalls) {
      const kind = activityKind(call.name);
      if (kind !== "ordinary") ordinaryGroup = undefined;
      const group = kind === "ordinary"
        ? ordinaryGroup ??= activityGroup({ text: batch.text, calls: ordinaryCalls })
        : activityGroup({ text: batch.text, calls: [call] });
      tools.push({ name: call.name, claimed: false, group });
    }
    return tools;
  }

  function ordinaryActivity(candidate: ActivityGroup): ActivityGroup {
    if (pendingStage) {
      candidate.displayStage = pendingStage;
      if (pendingExecutionTitle) {
        candidate.title = pendingExecutionTitle;
        if (candidate.interfaceContent) delete candidate.interfaceContent.title;
      }
      currentActivity = candidate;
      pendingStage = undefined;
      pendingExecutionTitle = undefined;
      fallbackOrdinaryActivity = undefined;
    }
    return currentActivity ?? (fallbackOrdinaryActivity ??= candidate);
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
      deferredUntilAccepted: first
        ? first.name === "continue_work" || !["ordinary", "work_selection"].includes(activityKind(first.name))
        : false,
      ...(first?.name === "continue_work" ? { resumesWork: true } : {}),
      title: boundedTitle(
        groupInput.title ||
          (first?.name === "record_work_checkpoint" && activeActionTitle) ||
          content.title,
      ),
      summary: commandActivity
        ? content.summary
        : distinctSummary(content.title, content.summary),
      interfaceContent: { ...content.interfaceContent,
        ...(content.interfaceContent?.summary && !commandActivity && distinctSummary(content.title, content.summary) !== content.summary ? { summary: { key: "checkingInformation" as const } } : {}),
      },
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
    if (groupInput.title || first?.name === "record_work_checkpoint" && activeActionTitle) {
      delete group.interfaceContent?.title;
    }
    if (first?.name === "replace_work_plan") {
      const conception: ActivityGroup = {
        activityId: activityId(input.turnId),
        displayStage: "conception",
        deferredUntilAccepted: group.deferredUntilAccepted,
        title: getAppCopy().guided.conceptionTitle,
        summary: conceptionSummary(content.summary),
        nextStep: getAppCopy().guided.planningNext,
        interfaceContent: { title: { key: "conceptionTitle" }, summary: { key: "conceptionSummary", parameters: { text: content.summary } }, nextStep: { key: "planningNext" } },
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
          title: getAppCopy().guided.reportTitle,
          summary: distinctSummary(getAppCopy().guided.reportTitle, reportingDirection),
          interfaceContent: { title: { key: "reportTitle" } },
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
      interfaceContent: group.interfaceContent,
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
