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
import type {
  AcceptedPhaseGuidance,
  PhaseGuidanceDraft,
  PhaseGuidanceRepository,
  PhaseGuidanceRevisionRef,
  PhaseGuidanceScope,
  PublishPhaseGuidanceCommand,
} from "./guidance/index.ts";
import type {
  ActualModelIdentity,
  OperationRequest,
  OperationResult,
  PhaseEnvelope,
  PhaseRunBinding,
} from "./core/index.ts";

export {
  assertLogicalLedgerMutationId,
  assertLogicalLedgerRecordBytes,
  createLogicalLedgerBundle,
  createWorkLedger,
  ledgerAttemptRef,
  ledgerManifestContentHash,
  ledgerMutationId,
  ledgerRecordSha256,
  logicalLedgerRecords,
} from "./work-ledger/index.ts";
export { operationRoundScope } from "./core/operation-identity.ts";
export {
  acceptFeedbackAuthority,
  acceptReviewedPlanAuthority,
  bindManagedProgram,
} from "./work-ledger/program-authority.ts";
export {
  projectEphemeralOperationResult,
  READ_OPERATION_RESULT_CAPABILITY,
} from "./operation-result/index.ts";
export type {
  LogicalLedgerBundle,
  LogicalLedgerRecord,
  WorkLedger,
  WorkLedgerCommit,
  WorkLedgerStorage,
  ManagedProgramAuthority,
} from "./work-ledger/index.ts";
export type {
  OperationResultProjection,
} from "./operation-result/index.ts";
export type { SpooledOperationOutput } from "./core/index.ts";
export type { RetrospectiveScheduler } from "./delivery/index.ts";
export type {
  BtccRuntimeDependencies,
  BtccTurnCommand,
  BtccTurnProgressObserver,
  FreshBtccTurnCommand,
} from "./contracts.ts";
export type { StopPersistenceOutcome } from "./turn/index.ts";
export type {
  AcceptedPhaseGuidance,
  ActualModelIdentity,
  OperationRequest,
  OperationResult,
  PhaseEnvelope,
  PhaseGuidanceDraft,
  PhaseGuidanceRepository,
  PhaseGuidanceRevisionRef,
  PhaseGuidanceScope,
  PhaseRunBinding,
  PublishPhaseGuidanceCommand,
};

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
