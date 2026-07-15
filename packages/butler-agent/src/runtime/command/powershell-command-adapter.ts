import type {
  CommandAdapter,
  CommandInvocation,
  CommandRequest,
  CommandResult,
} from "./contracts.ts";
import { runNodeCommand } from "./node-command-runner.ts";

export class PowerShellCommandAdapter implements CommandAdapter {
  async execute(request: CommandRequest): Promise<CommandResult> {
    return await runNodeCommand(powerShellInvocations(request), request);
  }
}

export function powerShellInvocations(request: CommandRequest): CommandInvocation[] {
  return request.plan.steps.map((step) => ({
    executable: step.executable,
    arguments: step.arguments ?? [],
  }));
}
