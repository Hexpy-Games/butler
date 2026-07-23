import type { BtccPersistenceTypes } from "../../../btcc/gateway-api.ts";
import { stableJson } from "./identity.ts";
import { SqliteImmutableRecordStore } from "./immutable-record-store.ts";
import { ManagedTurnProjectionWriter } from "./managed-turn-projection-writer.ts";
import type { ProjectLedgerBoundaryContext } from "./project-ledger-promotion-writer.ts";
import { ProjectManagedBoundary } from "./project-managed-boundary.ts";

type GoalTransition = Extract<BtccPersistenceTypes["transition"], {
  kind: "submit_goal_candidate" | "request_goal_revision" | "accept_goal_contract";
}>;
type ManagedTurnState = BtccPersistenceTypes["managedTurnState"];
type TurnRecord = BtccPersistenceTypes["turn"];

export class ManagedGoalTransitionWriter {
  constructor(
    private readonly records: SqliteImmutableRecordStore,
    private readonly projection: ManagedTurnProjectionWriter,
    private readonly boundary: ProjectManagedBoundary,
  ) {}

  commit(
    turn: TurnRecord,
    nextRevision: number,
    transition: GoalTransition,
    projectLedger: ProjectLedgerBoundaryContext,
  ): void {
    switch (transition.kind) {
      case "submit_goal_candidate":
        this.recordCandidate(transition.product);
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), goalCandidate: transition.product,
        });
        return;
      case "request_goal_revision":
        this.insert("goal_contract_review", transition.product.review);
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), goalRevision: transition.product,
        });
        return;
      case "accept_goal_contract": {
        const { goalContract, authority, review } = transition.product;
        this.insert("goal_contract", goalContract);
        this.insert("authority_revision", authority);
        this.insert("goal_contract_review", review);
        const program = this.boundary.commitProgram(transition.ledgerCommit, projectLedger);
        if (!program) throw new Error("Work Ledger boundary did not return its Program");
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), goalAcceptance: transition.product, program,
        }, { goalContractRef: goalContract.ref.id });
      }
    }
  }

  private recordCandidate(product: Extract<GoalTransition, {
    kind: "submit_goal_candidate";
  }>["product"]): void {
    this.insert("goal_contract_candidate", product.candidate);
    this.insert("goal_contract", product.candidate.proposedContract);
  }

  private advance(...input: Parameters<ManagedTurnProjectionWriter["advance"]>): void {
    this.projection.advance(...input);
  }

  private insert<T extends { ref: { id: string; sha256: string } }>(kind: string, value: T): void {
    this.records.insert(value.ref.id, kind, value.ref.sha256, stableJson(value));
  }
}

function requiredManaged(turn: TurnRecord): ManagedTurnState {
  if (!turn.managed) throw new Error(`Managed state is missing at ${turn.semanticState}`);
  return turn.managed;
}
