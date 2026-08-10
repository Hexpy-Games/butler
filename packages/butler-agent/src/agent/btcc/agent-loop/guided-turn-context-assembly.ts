import type { SqliteGuidedToolJournal } from "../../adapters/index.ts";
import type {
  DurableWorkContext,
  DurableWorkService,
  WorkTurnScope,
} from "../work/index.ts";
import type { TurnRecord } from "../turn/index.ts";
import {
  backfillTurnToolResults,
  safeBoundWork,
  safeImportOpenLegacyWork,
  safeLoadWorkContext,
  workScopeForTurn,
} from "./guided-work-runtime.ts";
import {
  createGuidedCompactReplayRuntime,
  type GuidedCompactReplayRuntime,
} from "./guided-compact-replay-runtime.ts";

export type GuidedTurnContextAssembly = {
  workScope: WorkTurnScope;
  initialWork: DurableWorkContext | null;
  initialWorkBound: boolean;
  compactReplayRuntime: GuidedCompactReplayRuntime;
};

export async function assembleGuidedTurnContext(input: {
  butlerData: string;
  compactReplayEnabled: boolean;
  durableWork: DurableWorkService;
  toolJournal: SqliteGuidedToolJournal;
  trackingMode: "ledger" | "local" | "none";
  turn: TurnRecord;
  projectRef?: string;
  modelRef: string;
  resolveModelRef?: () => string;
}): Promise<GuidedTurnContextAssembly> {
  const workScope = workScopeForTurn(input.turn, input.trackingMode);
  let initialWork = input.trackingMode === "none"
    ? null
    : await safeLoadWorkContext(input.durableWork, workScope);
  if (!initialWork && input.trackingMode !== "none") {
    await safeImportOpenLegacyWork(input.durableWork, workScope);
    initialWork = await safeLoadWorkContext(input.durableWork, workScope);
  }
  let initialWorkBound = false;
  if (initialWork) {
    const boundWork = await safeBoundWork(input.durableWork, input.turn.turnId);
    initialWorkBound = boundWork?.workId === initialWork.work.workId;
    if (initialWorkBound) {
      await backfillTurnToolResults(input, workScope);
      initialWork = await safeLoadWorkContext(input.durableWork, workScope);
    }
  }
  const compactReplayRuntime = await createGuidedCompactReplayRuntime({
    enabled: input.compactReplayEnabled,
    butlerData: input.butlerData,
    toolJournal: input.toolJournal,
    turnId: input.turn.turnId,
    sessionId: input.turn.sessionId,
    ...(input.projectRef ? { projectRef: input.projectRef } : {}),
    work: initialWork,
    modelRef: input.modelRef,
    ...(input.resolveModelRef ? { resolveModelRef: input.resolveModelRef } : {}),
  });
  return { workScope, initialWork, initialWorkBound, compactReplayRuntime };
}
