// Wall-clock budget guard for the consolidation-cycle orchestrator.
// Hard budget: total cycle deadline. Hard-exceeded → throw BudgetExceeded.
// Soft budget: per-sub-phase deadline. Soft-exceeded logs a warning but does
// not abort.

export class BudgetExceeded extends Error {
  constructor(public readonly phase: string | null) {
    super(`budget exceeded${phase ? ` in phase ${phase}` : ""}`);
    this.name = "BudgetExceeded";
  }
}

export class Budget {
  public readonly totalDeadlineMs: number;
  private subPhaseName: string | null = null;
  private subPhaseDeadlineMs = 0;

  constructor(totalBudgetMs: number, now: number = Date.now()) {
    this.totalDeadlineMs = now + totalBudgetMs;
  }

  remaining(): number {
    return this.totalDeadlineMs - Date.now();
  }

  subPhaseRemaining(): number {
    if (this.subPhaseName === null) return Infinity;
    return this.subPhaseDeadlineMs - Date.now();
  }

  isHardBudgetExceeded(): boolean {
    return this.remaining() <= 0;
  }

  isSoftBudgetExceeded(): boolean {
    if (this.subPhaseName === null) return false;
    return this.subPhaseRemaining() <= 0;
  }

  startSubPhase(name: string, softBudgetMs: number): void {
    this.subPhaseName = name;
    this.subPhaseDeadlineMs = Date.now() + softBudgetMs;
  }

  endSubPhase(): void {
    this.subPhaseName = null;
    this.subPhaseDeadlineMs = 0;
  }

  /** Throws BudgetExceeded if the hard budget has been exceeded. */
  check(): void {
    if (this.isHardBudgetExceeded()) {
      throw new BudgetExceeded(this.subPhaseName);
    }
  }

  currentSubPhase(): string | null {
    return this.subPhaseName;
  }
}
