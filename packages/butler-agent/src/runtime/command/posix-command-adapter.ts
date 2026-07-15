import type {
  CommandAdapter,
  CommandInvocation,
  CommandRequest,
  CommandResult,
} from "./contracts.ts";
import { runNodeCommand } from "./node-command-runner.ts";
import { posixProcessGroupContainment } from "./process-containment.ts";

export class PosixCommandAdapter implements CommandAdapter {
  async execute(request: CommandRequest): Promise<CommandResult> {
    return await runNodeCommand(
      posixInvocations(request),
      request,
      posixProcessGroupContainment,
    );
  }
}

export function posixInvocations(request: CommandRequest): CommandInvocation[] {
  return request.plan.steps.map((step) => ({
    executable: step.executable,
    arguments: step.arguments ?? [],
  }));
}
