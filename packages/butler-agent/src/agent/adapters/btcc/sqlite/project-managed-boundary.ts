import type { Database } from "bun:sqlite";
import type { WorkLedger, WorkLedgerCommit } from "../../../btcc/gateway-api.ts";
import {
  ProjectLedgerPromotionWriter,
  type ProjectLedgerBoundaryContext,
} from "./project-ledger-promotion-writer.ts";

export class ProjectManagedBoundary {
  private readonly promotions: ProjectLedgerPromotionWriter;

  constructor(db: Database, private readonly sessionLedger: WorkLedger) {
    this.promotions = new ProjectLedgerPromotionWriter(db);
  }

  recordPlanningBase(context: ProjectLedgerBoundaryContext): void {
    if (context.planningBase) this.promotions.recordPlanningBase(context.planningBase);
  }

  bindTurnCommit(input: {
    turnId: string;
    nextRevision: number;
    commit?: WorkLedgerCommit;
    context: ProjectLedgerBoundaryContext;
  }): void {
    if (!input.context.preparedPublication) return;
    if (!input.commit || !input.context.projectedProgram || !input.context.projectRef) {
      throw new Error("Project Ledger publication lacks its authoritative commit projection");
    }
    this.promotions.projectProgramProjection({
      projectRef: input.context.projectRef,
      program: input.context.projectedProgram,
    });
    this.promotions.preparePromotionOutbox({
      turnId: input.turnId,
      nextRevision: input.nextRevision,
      commit: input.commit,
      publication: input.context.preparedPublication,
    });
  }

  commitProgram(commit: WorkLedgerCommit, context: ProjectLedgerBoundaryContext) {
    if (!context.projectedProgram) return this.sessionLedger.commitAcceptedBoundary(commit);
    if (context.projectedProgram.programId !== programIdOf(commit)) {
      throw new Error("Project Work Ledger projected the wrong Program");
    }
    return context.projectedProgram;
  }
}

function programIdOf(commit: WorkLedgerCommit): string {
  if (commit.mutation.kind === "bind_program") {
    return commit.mutation.product.authority.managedBinding.programId;
  }
  if (commit.mutation.kind === "install_reviewed_plan") {
    return commit.mutation.product.candidate.programId;
  }
  return commit.mutation.cursor.programId;
}
