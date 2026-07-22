import type { GoalContractAcceptedProduct } from "./conception/index.ts";
import type { ResultCandidateProduct } from "./execution/index.ts";
import type { PlanningAcceptedProduct } from "./planning/index.ts";
import type { TaskReviewProduct } from "./review/index.ts";
import type {
  AcceptedTurnTransition,
  ManagedProgramState,
  ManagedTurnState,
  TurnRecord,
  TurnSemanticState,
} from "./turn/index.ts";
import type { ManagedAttempt } from "./work/index.ts";
import type { DeferredContinuationCandidate } from "./continuation/index.ts";

export { createWorkLedger } from "./work-ledger/index.ts";
export type {
  WorkLedger,
  WorkLedgerCommit,
  WorkLedgerStorage,
} from "./work-ledger/index.ts";
export type { RetrospectiveScheduler } from "./delivery/index.ts";
export type {
  BtccRuntimeDependencies,
  BtccTurnCommand,
  BtccTurnProgressObserver,
  FreshBtccTurnCommand,
} from "./contracts.ts";
export type { StopPersistenceOutcome } from "./turn/index.ts";

export type BtccPersistenceTypes = {
  transition: AcceptedTurnTransition;
  turn: TurnRecord;
  semanticState: TurnSemanticState;
  managedTurnState: ManagedTurnState;
  managedProgramState: ManagedProgramState;
  managedAttempt: ManagedAttempt;
  goalContractAcceptedProduct: GoalContractAcceptedProduct;
  planningAcceptedProduct: PlanningAcceptedProduct;
  resultCandidateProduct: ResultCandidateProduct;
  taskReviewProduct: TaskReviewProduct;
  deferredContinuationCandidate: DeferredContinuationCandidate;
};
