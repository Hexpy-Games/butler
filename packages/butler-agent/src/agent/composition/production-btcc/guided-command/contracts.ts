import type { ChildProcess } from "node:child_process";

export type GuidedCommandContext = {
  butlerData: string;
  workspacePath: string;
  originalRequest: string;
  accessMode: "full_access" | "read_only";
  filesystemBoundary:
    | { kind: "read_only_observation" }
    | { kind: "full_access_contained" }
    | {
      kind: "isolated_validation";
      writeRoots: string[];
      homeRoot: string;
      tempRoot: string;
      artifactRoot: string;
    };
  signal?: AbortSignal;
};

export interface CommandInvocation {
  executable: string;
  args: string[];
}

export interface CommandHostAdapter {
  detached: boolean;
  invocation(command: string, context: GuidedCommandContext): CommandInvocation;
  terminate(child: ChildProcess): void;
  terminateDescendants(child: ChildProcess): void;
}

export type SpooledCommandOutput = {
  kind: "spooled_command_output";
  summary: CommandOutputSummary;
  payloadSource: {
    kind: "spooled_text";
    path: string;
    sha256: string;
    byteLength: number;
    mediaType: "text/plain; charset=utf-8";
  };
};

export type CommandOutputSummary = {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
};
