export class LedgerContentionInterruption extends Error {
  constructor(
    readonly contentionId: string,
    private readonly resolveContention: (signal?: AbortSignal) => Promise<void>,
  ) {
    super("Project Ledger boundary is durably owned by a competing Turn");
    this.name = "LedgerContentionInterruption";
  }

  waitForRelease(signal?: AbortSignal): Promise<void> {
    return this.resolveContention(signal);
  }
}
