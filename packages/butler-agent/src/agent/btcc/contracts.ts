export type BtccTurnCommand =
  | {
      kind: "run";
      turnId: string;
      sessionId: string;
      messageId: string;
    }
  | { kind: "resume"; turnId: string }
  | { kind: "wake"; turnId: string; triggerId: string }
  | { kind: "stop"; turnId: string };

export type BtccTurnOutcome =
  | { kind: "delivered"; turnId: string; messageId: string }
  | { kind: "cancelled"; turnId: string };

export interface BtccTurnRuntime {
  handle(command: BtccTurnCommand): Promise<BtccTurnOutcome>;
}
