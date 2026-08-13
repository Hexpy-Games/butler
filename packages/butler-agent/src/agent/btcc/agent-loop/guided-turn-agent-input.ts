import type { SqliteGuidedEffectJournal } from "../../adapters/index.ts";
import type { ModelRoundPort } from "../ports/model-round.ts";
import type { GuidedOperationResultReader, GuidedToolJournal } from "../ports/index.ts";
import type { DurableWorkService } from "../work/index.ts";
import type { GuidedSessionWorkspaceBindingStore } from
  "./guided-session-workspace-recovery.ts";

export type ProductionGuidedTurnAgentInput = {
  butlerHome: string;
  butlerData: string;
  contextDocuments: { resolve(contextRef: string): string };
  toolJournal: GuidedToolJournal;
  operationResultReader?: GuidedOperationResultReader;
  effectJournal: SqliteGuidedEffectJournal;
  durableWork: DurableWorkService;
  modelRound?: ModelRoundPort;
  sessionBindingStore?: GuidedSessionWorkspaceBindingStore;
  executionWindowSize?: number;
};
