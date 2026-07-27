import {
  reconcileBtccTerminalDeliveryBatch,
} from "./btcc-terminal-projection.ts";
import {
  reconcileBtccTurnProjectionAuthorityBatch,
} from "./btcc-turn-projection-authority.ts";
import type {
  AppTransportProjectionStoreOptions,
} from "./transport-projection-contract.ts";

export class AppTransportHistoricalReconciliationStore {
  private authorityComplete = false;
  private authorityCursor = 0;
  private terminalComplete = false;
  private terminalCursor = 0;
  private preferTerminal = false;

  constructor(
    private readonly input: {
      options: AppTransportProjectionStoreOptions;
      hasProjectedAction: (actionId: string) => boolean;
      markProjectedAction: (
        actionId: string,
        eventId: string,
        targetChatId: string,
      ) => void;
    },
  ) {}

  reconcileNextPage(): boolean {
    const reconcileTerminal = !this.terminalComplete &&
      (this.preferTerminal || this.authorityComplete);
    if (reconcileTerminal) this.reconcileTerminalPage();
    else if (!this.authorityComplete) this.reconcileAuthorityPage();
    if (this.authorityComplete && this.terminalComplete) {
      this.resetCycle();
      return false;
    }
    this.preferTerminal = !reconcileTerminal;
    return true;
  }

  private reconcileAuthorityPage(): void {
    const result = reconcileBtccTurnProjectionAuthorityBatch(
      this.input.options.db,
      { afterRowId: this.authorityCursor },
    );
    this.authorityCursor = result.nextCursor;
    this.authorityComplete = !result.pending;
  }

  private reconcileTerminalPage(): void {
    const result = reconcileBtccTerminalDeliveryBatch({
      options: this.input.options,
      hasProjectedAction: this.input.hasProjectedAction,
      markProjectedAction: this.input.markProjectedAction,
      afterRowId: this.terminalCursor,
    });
    this.terminalCursor = result.nextCursor;
    this.terminalComplete = !result.pending;
  }

  private resetCycle(): void {
    this.authorityComplete = false;
    this.authorityCursor = 0;
    this.terminalComplete = false;
    this.terminalCursor = 0;
    this.preferTerminal = false;
  }
}
