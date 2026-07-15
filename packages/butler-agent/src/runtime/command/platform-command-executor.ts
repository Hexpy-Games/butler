import type {
  CommandAdapter,
  CommandExecutor,
  CommandRequest,
  CommandResult,
} from "./contracts.ts";
import { PosixCommandAdapter } from "./posix-command-adapter.ts";
import { PowerShellCommandAdapter } from "./powershell-command-adapter.ts";

export class PlatformCommandExecutor implements CommandExecutor {
  private readonly adapter: CommandAdapter;

  constructor(input: {
    platform?: NodeJS.Platform;
    posixAdapter?: CommandAdapter;
    powerShellAdapter?: CommandAdapter;
  } = {}) {
    const platform = input.platform ?? process.platform;
    this.adapter = platform === "win32"
      ? (input.powerShellAdapter ?? new PowerShellCommandAdapter())
      : (input.posixAdapter ?? new PosixCommandAdapter());
  }

  async execute(request: CommandRequest): Promise<CommandResult> {
    return await this.adapter.execute(request);
  }
}

export function createPlatformCommandExecutor(): CommandExecutor {
  return new PlatformCommandExecutor();
}
