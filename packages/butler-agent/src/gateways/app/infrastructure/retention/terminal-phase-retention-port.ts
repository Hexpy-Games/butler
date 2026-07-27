export interface TerminalPhaseRetentionPort {
  isSettled(turnId: string): boolean;
  compactTurn(turnId: string): boolean;
}
