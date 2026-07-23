import type {
  WorkLedger,
  WorkLedgerCommit,
  WorkLedgerStorage,
} from "./contracts.ts";

class DefaultWorkLedger implements WorkLedger {
  constructor(private readonly storage: WorkLedgerStorage) {}

  commitAcceptedBoundary(input: WorkLedgerCommit) {
    this.storage.commit(input);
    const programId = programIdOf(input);
    const program = this.storage.loadProgram(programId);
    if (!program && input.mutation.kind !== "bind_program") {
      throw new Error(`Work Ledger did not reload committed Program ${programId}`);
    }
    return program;
  }

  loadProgram(programId: string) {
    return this.storage.loadProgram(programId);
  }
}

function programIdOf(input: WorkLedgerCommit): string {
  switch (input.mutation.kind) {
    case "bind_program":
      return input.mutation.product.authority.managedBinding.programId;
    case "install_reviewed_plan":
      return input.mutation.product.candidate.programId;
    case "select_attempt":
    case "attach_result":
    case "attach_review":
    case "accept_feedback_plan":
    case "close_implementation_frontier":
    case "close_promotion_frontier":
    case "accept_managed_deferral":
    case "accept_promotion_deferral":
    case "close_deferred_promotion_frontier":
      return input.mutation.cursor.programId;
  }
}

export function createWorkLedger(storage: WorkLedgerStorage): WorkLedger {
  return new DefaultWorkLedger(storage);
}
