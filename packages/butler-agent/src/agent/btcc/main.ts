import type {
  BtccRuntimeDependencies,
  BtccTurnCommand,
  BtccTurnOutcome,
  BtccTurnRuntime,
} from "./contracts.ts";
import { runTurn, stopTurn } from "./turn/index.ts";

class DefaultBtccTurnRuntime implements BtccTurnRuntime {
  constructor(private readonly dependencies: BtccRuntimeDependencies) {}

  handle(command: BtccTurnCommand): Promise<BtccTurnOutcome> {
    switch (command.kind) {
      case "run":
      case "resume":
      case "wake":
        return runTurn(command, this.dependencies);
      case "stop":
        return stopTurn(command);
    }
  }
}

export function createBtccTurnRuntime(
  dependencies: BtccRuntimeDependencies,
): BtccTurnRuntime {
  return new DefaultBtccTurnRuntime(dependencies);
}
