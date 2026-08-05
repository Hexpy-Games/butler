import type {
  ModelRouteState,
} from "../../../btcc/model-route/index.ts";
import type { ModelRoundResult } from "../../../btcc/ports/index.ts";

export type SqliteModelRouteEventInput = {
  turnId: string;
  expectedRevision: number;
  executionFence: number;
  claimId: string;
  event: {
    type: string;
    roundId: string;
    candidateIndex: number;
    transportAttempt?: number;
    modelRef: string;
    errorCode?: string;
  };
  route?: ModelRouteState;
};

export type SqliteModelRouteAttemptHistoryInput = {
  turnId: string;
  roundId: string;
  routeDigest: string;
  candidateIndex: number;
  modelRef: string;
};

export type SqliteModelRoundAcceptanceInput = {
  turnId: string;
  expectedRevision: number;
  executionFence: number;
  claimId: string;
  checkpointId: string;
  checkpointRevision: number;
  roundId: string;
  routeDigest: string;
  candidateIndex: number;
  transportAttempt: number;
  modelRef: string;
  result: ModelRoundResult;
};
