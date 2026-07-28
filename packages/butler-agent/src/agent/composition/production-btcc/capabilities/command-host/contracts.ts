import type { ChildProcess } from "node:child_process";
import type { CapabilityExecutionContext } from "../contracts.ts";

export interface CommandInvocation {
  executable: string;
  args: string[];
}

export interface CommandHostAdapter {
  detached: boolean;
  invocation(
    command: string,
    context: CapabilityExecutionContext,
  ): CommandInvocation;
  terminate(child: ChildProcess): void;
}
