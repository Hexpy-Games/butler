import type { GoalContractAcceptedProduct } from "./conception/index.ts";
import type { ResultCandidateProduct } from "./execution/index.ts";
import type { PlanningAcceptedProduct } from "./planning/index.ts";
import type { TaskReviewProduct } from "./review/index.ts";
import type {
  AcceptedTurnTransition,
  ManagedTurnState,
  TurnRecord,
  TurnSemanticState,
} from "./turn/index.ts";
import type { ManagedProgramState } from "./turn/managed-turn-state.ts";
import type { ManagedAttempt } from "./work/index.ts";

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
};
