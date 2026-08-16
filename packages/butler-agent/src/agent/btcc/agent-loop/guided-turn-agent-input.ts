import type { SqliteGuidedEffectJournal } from "../../adapters/index.ts";
import type {
  ModelRoundPort,
  PhaseContinuityPrivateDigester,
} from "../ports/model-round.ts";
import type { GuidedOperationResultReader, GuidedToolJournal } from "../ports/index.ts";
import type { DurableWorkService } from "../work/index.ts";
import type { GuidedSessionWorkspaceBindingStore } from
  "./guided-session-workspace-recovery.ts";
import type { ContextDocumentReader } from "../../context/context-projection.ts";

export type ProductionGuidedTurnAgentInput = {
  butlerHome: string;
  butlerData: string;
  phaseContinuityPrivateDigester: PhaseContinuityPrivateDigester;
  contextDocuments: ContextDocumentReader;
  toolJournal: GuidedToolJournal;
  operationResultReader?: GuidedOperationResultReader;
  effectJournal: SqliteGuidedEffectJournal;
  durableWork: DurableWorkService;
  modelRound?: ModelRoundPort;
  sessionBindingStore?: GuidedSessionWorkspaceBindingStore;
  executionWindowSize?: number;
};
