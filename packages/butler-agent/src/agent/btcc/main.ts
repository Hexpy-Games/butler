import type { BtccTurnCommand, BtccTurnOutcome, BtccTurnRuntime } from "./contracts.ts";
import { runTurn, stopTurn } from "./turn/index.ts";

class DefaultBtccTurnRuntime implements BtccTurnRuntime {
  handle(command: BtccTurnCommand): Promise<BtccTurnOutcome> {
    switch (command.kind) {
      case "run":
      case "resume":
      case "wake":
        return runTurn(command);
      case "stop":
        return stopTurn(command);
    }
  }
}

export function createBtccTurnRuntime(): BtccTurnRuntime {
  return new DefaultBtccTurnRuntime();
}
