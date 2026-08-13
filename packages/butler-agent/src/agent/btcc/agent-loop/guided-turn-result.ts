import type { SqliteGuidedEffectJournal, SqliteGuidedToolJournal } from
  "../../adapters/index.ts";
import type { BtccAgentLoopResult } from "./contracts.ts";
import { isDurableWorkTool } from "../work/index.ts";
import { routeForUsedTools } from "./guided-turn-policy.ts";
import { guidedOperationalFallbackAfterInternalId } from
  "./guided-operational-facts.ts";
import { collectGuidedFinalArtifacts } from "./guided-final-artifacts.ts";
import type { safeBoundWork } from "./guided-work-runtime.ts";

type FinalWork = Awaited<ReturnType<typeof safeBoundWork>>;

export async function finalizeGuidedTurnResult(input: {
  text: string;
  originalRequest: string;
  turnId: string;
  responseLanguage: string;
  initialWorkId?: string;
  finalWork: FinalWork;
  usedTools: readonly string[];
  toolJournal: SqliteGuidedToolJournal;
  effectJournal: SqliteGuidedEffectJournal;
  readProgress: () => readonly string[];
  modelIdentity?: BtccAgentLoopResult["modelIdentity"];
}): Promise<BtccAgentLoopResult> {
  const internalWorkIds = [input.initialWorkId, input.finalWork?.workId]
    .filter((workId): workId is string => Boolean(workId));
  const content = internalWorkIds.some((workId) => input.text.includes(workId))
    ? await guidedOperationalFallbackAfterInternalId({
        originalRequest: input.originalRequest,
        turnId: input.turnId,
        responseLanguage: input.responseLanguage,
        finalWork: input.finalWork,
        internalWorkIds,
        listToolCalls: () => input.toolJournal.list(input.turnId),
        listEffectsForWork: (workId) => input.effectJournal.listForWork(workId),
        readProgress: input.readProgress,
      })
    : input.text;
  const artifacts = collectGuidedFinalArtifacts(
    input.toolJournal.list(input.turnId),
  );
  return {
    content,
    ...(input.modelIdentity ? { modelIdentity: input.modelIdentity } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    route: routeForUsedTools(
      input.usedTools,
      Boolean(input.finalWork) || input.usedTools.some(isDurableWorkTool),
    ),
  };
}
