export interface CommandStep {
  executable: string;
  arguments?: readonly string[];
}

export interface CommandPlan {
  steps: readonly [CommandStep, ...CommandStep[]];
}

export interface CommandRequest {
  plan: CommandPlan;
  cwd?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  inheritEnvironment?: boolean;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CommandError {
  code: string;
  message: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  error: CommandError | null;
}

export interface CommandExecutor {
  execute(request: CommandRequest): Promise<CommandResult>;
}

export interface CommandAdapter extends CommandExecutor {}

export interface CommandInvocation {
  executable: string;
  arguments: readonly string[];
}
