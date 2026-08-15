import type {
  SqliteGuidedEffectJournal,
  SqliteGuidedToolJournal,
} from "../../adapters/index.ts";
import type { ModelRoundPort } from "../ports/model-round.ts";
import type { DurableWorkService } from "../work/index.ts";
import type { GuidedSessionWorkspaceBindingStore } from
  "./guided-session-workspace-recovery.ts";

export type ProductionGuidedTurnAgentInput = {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath: string;
  contextDocuments: { resolve(contextRef: string): string };
  toolJournal: SqliteGuidedToolJournal;
  effectJournal: SqliteGuidedEffectJournal;
  durableWork: DurableWorkService;
  modelRound?: ModelRoundPort;
  sessionBindingStore?: GuidedSessionWorkspaceBindingStore;
  /** Test seam for exercising more than one internal execution window. */
  executionWindowSize?: number;
};
