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
const MAX_EFFECT_RECORDS = 50;

export function createGuidedRoundToolSurfaceResolver(input: {
  turnId: string;
  tools: readonly BtccAgentLoopToolDefinition[];
  requiredToolNames: ReadonlySet<string>;
  toolJournal: Pick<GuidedToolJournal, "list">;
  durableWork: DurableWorkService;
  workScope: WorkTurnScope;
  effectJournal: Pick<GuidedEffectJournal, "listForWork">;
}): () => Promise<BtccRoundToolSurfaceSnapshot> {
  return async () => {
    const work = await currentWork(input);
    const dispositionReady = await canExposeDisposition(input, work);
    const eligibleTools = input.tools.filter((tool) =>
      tool.name !== DISPOSITION_TOOL || dispositionReady,
    );
    const tools = projectDurableWorkToolSurface(eligibleTools, work);
    const names = new Set(tools.map((tool) => tool.name));
    const missingRequired = [...input.requiredToolNames]
      .find((name) => input.tools.some((tool) => tool.name === name) && !names.has(name));
    if (missingRequired) {
      throw new RoundToolSurfaceError("round_tool_surface_required_tool_missing");
    }
    return createRoundToolSurfaceSnapshot(tools);
  };
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
}): Promise<DurableWorkView | undefined> {
  const bound = await safeBoundWork(input.durableWork, input.turnId);
  const context = await safeLoadWorkContext(input.durableWork, input.workScope);
  return bound ?? context?.work ?? undefined;
}
