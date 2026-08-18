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
import type { PrincipalAuthority } from "../authority/index.ts";

export type ProductionGuidedTurnAgentInput = {
  butlerHome: string;
  butlerData: string;
  phaseContinuityPrivateDigester: PhaseContinuityPrivateDigester;
  contextDocuments: ContextDocumentReader;
  toolJournal: GuidedToolJournal;
  operationResultReader?: GuidedOperationResultReader;
  effectJournal: SqliteGuidedEffectJournal;
  authority: PrincipalAuthority;
  durableWork: DurableWorkService;
  modelRound?: ModelRoundPort;
  sessionBindingStore?: GuidedSessionWorkspaceBindingStore;
  executionWindowSize?: number;
};
