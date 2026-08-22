import type { BtccAgentLoopResult } from "../../../agent/btcc/agent-loop/index.ts";
import type { TurnRecord } from "../../../agent/btcc/turn/index.ts";
import type { RuntimeFailureDiagnostic } from "../../../integrations/providers/provider-errors.ts";

export type TurnModelTurnCaptureInput = {
  kind: "model_turn";
  turn: TurnRecord;
  result: BtccAgentLoopResult;
  timestamp: string;
};

export type TurnModelErrorCaptureInput = {
  kind: "model_turn_error";
  turn: TurnRecord;
  failure: RuntimeFailureDiagnostic;
  diagnostics?: Record<string, unknown>;
  timestamp: string;
};

export type TurnDeveloperLogCaptureInput =
  | TurnModelTurnCaptureInput
  | TurnModelErrorCaptureInput;

/**
 * Developer-diagnostics seam invoked by the BTCC Turn runtime at the terminal
 * outcome of every fresh agent execution. Implementations must never throw
 * into the turn path and must stay silent when diagnostics are disabled.
 */
export interface TurnDeveloperLogCapturePort {
  capture(input: TurnDeveloperLogCaptureInput): void;
}
