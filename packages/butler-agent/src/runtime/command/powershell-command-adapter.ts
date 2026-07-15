import type {
  CommandAdapter,
  CommandInvocation,
  CommandRequest,
  CommandResult,
} from "./contracts.ts";
import { dirname, join } from "node:path";
import { runNodeCommand } from "./node-command-runner.ts";

export class PowerShellCommandAdapter implements CommandAdapter {
  private readonly processHost: string;

  constructor(input: { processHost?: string } = {}) {
    this.processHost = input.processHost ?? windowsProcessHostExecutable();
  }

  async execute(request: CommandRequest): Promise<CommandResult> {
    return await runNodeCommand(
      powerShellInvocations(request, this.processHost),
      request,
    );
  }
}

export function powerShellInvocations(
  request: CommandRequest,
  processHost: string = windowsProcessHostExecutable(),
): CommandInvocation[] {
  return request.plan.steps.map((step) => ({
    executable: processHost,
    arguments: [step.executable, ...(step.arguments ?? [])],
  }));
}

export function windowsProcessHostExecutable(
  env: NodeJS.ProcessEnv = process.env,
  runtimeExecutable: string = process.execPath,
): string {
  return env.BUTLER_WINDOWS_PROCESS_HOST?.trim() ||
    join(dirname(runtimeExecutable), "butler-process-host.exe");
}
