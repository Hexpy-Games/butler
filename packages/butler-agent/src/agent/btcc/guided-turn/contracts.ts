import type { BtccTurnProgressObserver } from "../contracts.ts";
import type { TurnRecord } from "../turn/index.ts";

export type GuidedTurnResult = {
  content: string;
  route: "direct" | "assisted" | "managed";
};

export interface GuidedTurnAgent {
  run(input: {
    turn: TurnRecord;
    signal: AbortSignal;
    progress?: BtccTurnProgressObserver;
  }): Promise<GuidedTurnResult>;
}
