import type { BtccTurnProgressObserver } from "../contracts.ts";
import type { GuidedActivityProjection } from "../projection/index.ts";
import type { TurnRecord } from "../turn/index.ts";
import type { DurableWorkService, WorkTurnScope } from "../work/index.ts";
import type { SqliteGuidedToolJournal } from "../../adapters/index.ts";
import type { ContextualButlerToolExecutor } from
  "../../tools/butler-tools.ts";
import type { GuidedCompactReplayRuntime } from
  "./guided-compact-replay-runtime.ts";
import type { StateExecutionClaim } from "../turn/contracts.ts";

export type GuidedToolCallExecutionInput = {
  turn: TurnRecord;
  signal: AbortSignal;
  resolveModelRef?: () => string;
  progress?: BtccTurnProgressObserver;
  activity?: GuidedActivityProjection;
  workScope: WorkTurnScope;
  presentedWorkId?: string;
  authorizedNames: ReadonlySet<string>;
  visibleNames: ReadonlySet<string>;
  describedToolIds: Set<string>;
  durableWork: DurableWorkService;
  toolJournal: SqliteGuidedToolJournal;
  executeButlerTool: ContextualButlerToolExecutor;
  compactReplayRuntime: GuidedCompactReplayRuntime;
  continuationBudget?: {
    claim: StateExecutionClaim;
  };
};
