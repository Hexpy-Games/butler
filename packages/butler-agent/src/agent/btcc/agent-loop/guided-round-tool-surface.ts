import type { GuidedEffectJournal } from "../effects/index.ts";
import type { GuidedToolJournal } from "../ports/index.ts";
import { RoundToolSurfaceError } from "../ports/model-round.ts";
import type { DurableWorkService, WorkTurnScope } from "../work/index.ts";
import type { DurableWorkView } from "../work/index.ts";
import type { BtccAgentLoopToolDefinition } from "./contracts.ts";
import { projectDurableWorkToolSurface } from "./durable-work-tool-surface.ts";
import { safeBoundWork, safeLoadWorkContext } from "./guided-work-runtime.ts";
import {
  createRoundToolSurfaceSnapshot,
  type BtccRoundToolSurfaceSnapshot,
} from "./round-tool-surface.ts";
const DISPOSITION_TOOL = "record_work_disposition";
const DELEGATION_TOOL = "delegate_to_steward";
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
}): () => Promise<BtccRoundToolSurfaceSnapshot> {
  return async () => {
    const { bound, work } = await currentWork(input);
    const dispositionReady = await canExposeDisposition(input, work);
    const delegationReady = canExposeDelegation(bound);
    const eligibleTools = input.tools.filter((tool) => {
      if (delegationReady) return tool.name === DELEGATION_TOOL;
      if (tool.name === DISPOSITION_TOOL) {
        return input.projectWorkSurface === false || dispositionReady;
      }
      if (tool.name === DELEGATION_TOOL) return delegationReady;
      return true;
    });
    const tools = input.projectWorkSurface === false
      ? eligibleTools
      : projectDurableWorkToolSurface(eligibleTools, work);
    const names = new Set(tools.map((tool) => tool.name));
    const missingRequired = delegationReady ? undefined : [...input.requiredToolNames]
      .find((name) => input.tools.some((tool) => tool.name === name) && !names.has(name));
    if (missingRequired) {
      throw new RoundToolSurfaceError("round_tool_surface_required_tool_missing");
    }
    return createRoundToolSurfaceSnapshot(tools);
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
}> {
  const bound = await safeBoundWork(input.durableWork, input.turnId);
  const context = await safeLoadWorkContext(input.durableWork, input.workScope);
  return {
    bound: bound ?? undefined,
    work: bound ?? context?.work ?? undefined,
  };
}
