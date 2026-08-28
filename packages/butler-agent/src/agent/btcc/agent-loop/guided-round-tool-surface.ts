import type { GuidedEffectJournal } from "../effects/index.ts";
import type { GuidedToolJournal } from "../ports/index.ts";
import { RoundToolSurfaceError } from "../ports/model-round.ts";
import type { DurableWorkService, WorkTurnScope } from "../work/index.ts";
import type { DurableWorkView } from "../work/index.ts";
import type {
  DelegationPacket,
  SubsessionDelegationService,
} from "../subsessions/index.ts";
import { BUTLER_TOOLS } from "../../tools/butler-tools.ts";
import type { ButlerToolExecutor } from "../../tools/butler-tools.ts";
import type { BtccAgentLoopInput, BtccAgentLoopToolDefinition } from "./contracts.ts";
import { projectDurableWorkToolSurface } from "./durable-work-tool-surface.ts";
import {
  createRoundToolSurfaceSnapshot,
  type BtccRoundToolSurfaceSnapshot,
} from "./round-tool-surface.ts";
const DISPOSITION_TOOL = "record_work_disposition";
const ACTIVE_DELEGATION_TOOLS = new Set([
  "start_work",
  "steer_steward",
  "cancel_steward",
]);
const ACTIVE_RELATION_CONTROL_TOOLS = new Set([
  "steer_steward",
  "cancel_steward",
]);
const EFFECT_FREE_TOOL_NAMES = new Set(
  BUTLER_TOOLS
    .filter((tool) => tool.effectBoundary === "none")
    .map((tool) => tool.name),
);
const MAX_EFFECT_RECORDS = 50;

export function createGuidedRoundToolSurfaceResolver(input: {
  turnId: string;
  tools: readonly BtccAgentLoopToolDefinition[];
  requiredToolNames: ReadonlySet<string>;
  toolJournal: Pick<GuidedToolJournal, "list">;
  durableWork: DurableWorkService;
  workScope: WorkTurnScope;
  effectJournal: Pick<GuidedEffectJournal, "listForWork">;
  projectWorkSurface?: boolean;
  parentSessionId?: string;
  subsessionDelegation?: Pick<SubsessionDelegationService, "activeParentDelegations">;
  onActiveDelegationAdmission?: (active: boolean) => void;
  /** Butler hands off after Plan Review; Steward may execute directly or use a Worker. */
  forcedDelegationTool?: "delegate_to_steward";
}): () => Promise<BtccRoundToolSurfaceSnapshot> {
  return async () => {
    const activeDelegations = input.parentSessionId && input.subsessionDelegation
      ? await input.subsessionDelegation.activeParentDelegations({
          parentSessionId: input.parentSessionId,
        })
      : [];
    const { bound, work, readFailed } = await currentWork(input);
    const activeDelegationAdmission = activeDelegations.length > 0 &&
      (readFailed || (!bound && activeDelegations.some((delegation) =>
        sameCurrentReviewedWork(work, delegation.parent_work_ref))));
    input.onActiveDelegationAdmission?.(activeDelegationAdmission);
    const dispositionReady = activeDelegationAdmission
      ? false
      : await canExposeDisposition(input, work);
    const delegationReady = canExposeDelegation(bound);
    const eligibleTools = input.tools.filter((tool) => {
      if (activeDelegationAdmission) {
        return isActiveDelegationAdmissionTool(tool.name);
      }
      if (ACTIVE_RELATION_CONTROL_TOOLS.has(tool.name) &&
        activeDelegations.length === 0) return false;
      if (bound && (tool.name === "start_work" || tool.name === "continue_work")) {
        return false;
      }
      if (delegationReady && input.forcedDelegationTool) {
        return tool.name === input.forcedDelegationTool;
      }
      if (tool.name === DISPOSITION_TOOL) {
        return input.projectWorkSurface === false || dispositionReady;
      }
      if (tool.name === input.forcedDelegationTool) return delegationReady;
      return true;
    });
    const tools = input.projectWorkSurface === false
      ? eligibleTools
      : projectDurableWorkToolSurface(eligibleTools, work);
    const names = new Set(tools.map((tool) => tool.name));
    const missingRequired = delegationReady || activeDelegationAdmission
      ? undefined
      : [...input.requiredToolNames]
      .find((name) => input.tools.some((tool) => tool.name === name) && !names.has(name));
    if (missingRequired) {
      throw new RoundToolSurfaceError("round_tool_surface_required_tool_missing");
    }
    return createRoundToolSurfaceSnapshot(tools);
  };
}

function sameCurrentReviewedWork(
  work: DurableWorkView | undefined,
  parentWorkRef: DelegationPacket["parent_work_ref"],
): boolean {
  const plan = work?.currentPlan;
  const review = work?.latestPlanReview;
  if (!work || (work.status !== "open" && work.status !== "blocked") ||
    !plan || review?.subject !== "plan" ||
    review.verdict !== "accept" ||
    review.boundPlanRevisionId !== plan.planRevisionId) return false;
  return work.workId === parentWorkRef.work_id &&
    work.sessionId === parentWorkRef.session_id &&
    plan.planRevisionId === parentWorkRef.plan_revision_id &&
    review.reviewRevisionId === parentWorkRef.review_revision_id;
}

function isActiveDelegationAdmissionTool(name: string): boolean {
  return EFFECT_FREE_TOOL_NAMES.has(name) || ACTIVE_DELEGATION_TOOLS.has(name);
}

export function createActiveDelegationAdmissionGuard(): {
  observe(active: boolean): void;
  execute(execute: ButlerToolExecutor): BtccAgentLoopInput["executeTool"];
} {
  let active = false;
  return {
    observe(value) {
      active = value;
    },
    execute(execute) {
      return async (call) => {
        if (active && !isActiveDelegationAdmissionTool(call.name)) {
          return {
            ok: false,
            error: {
              code: "active_delegated_work_tool_forbidden",
              message: "This fresh Turn cannot continue, mutate, execute, or re-delegate the active Steward-owned Work.",
            },
          };
        }
        return await execute({
          name: call.name,
          args: call.arguments,
          rawArguments: call.rawArguments,
          providerCallId: call.id,
          signal: call.signal,
        });
      };
    },
  };
}

function canExposeDelegation(work: DurableWorkView | undefined): boolean {
  const plan = work?.currentPlan;
  const review = work?.latestPlanReview;
  return Boolean(
    work && (work.status === "open" || work.status === "blocked") &&
    plan && review?.subject === "plan" &&
    review.verdict === "accept" &&
    review.boundPlanRevisionId === plan.planRevisionId,
  );
}

async function canExposeDisposition(input: {
  effectJournal: Pick<GuidedEffectJournal, "listForWork">;
}, work: DurableWorkView | undefined): Promise<boolean> {
  if (!work || (work.status !== "open" && work.status !== "blocked") ||
      (work.effectBlockers?.length ?? 0) > 0) return false;
  const effects = await input.effectJournal.listForWork(
    work.workId,
    MAX_EFFECT_RECORDS,
  );
  return effects.length < MAX_EFFECT_RECORDS && effects.every((effect) =>
    effect.status === "applied" || effect.status === "failed",
  );
}

async function currentWork(input: {
  turnId: string;
  durableWork: DurableWorkService;
  workScope: WorkTurnScope;
}): Promise<{
  bound: DurableWorkView | undefined;
  work: DurableWorkView | undefined;
  readFailed: boolean;
}> {
  let bound: DurableWorkView | null = null;
  let context: Awaited<ReturnType<DurableWorkService["loadContext"]>> = null;
  let readFailed = false;
  try {
    bound = await input.durableWork.boundWorkForTurn(input.turnId);
  } catch {
    readFailed = true;
  }
  try {
    context = await input.durableWork.loadContext(input.workScope);
  } catch {
    readFailed = true;
  }
  return {
    bound: bound ?? undefined,
    work: bound ?? context?.work ?? undefined,
    readFailed,
  };
}
