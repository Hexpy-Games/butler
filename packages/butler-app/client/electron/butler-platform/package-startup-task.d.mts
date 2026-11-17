import { execFile as nodeExecFile } from "node:child_process";

export function createPackageStartupTask(input: {
  agentExecutable: string;
  execFile?: typeof nodeExecFile;
}): { read(): Promise<boolean>; set(enabled: boolean): Promise<boolean> };
