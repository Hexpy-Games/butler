export class PlanningProposalDefect extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlanningProposalDefect";
  }
}

export function rejectPlanningProposal(code: string, message: string): never {
  throw new PlanningProposalDefect(code, message);
}
