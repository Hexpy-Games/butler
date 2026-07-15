import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface CommandProcessContainment {
  detached: boolean;
  signal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void;
}

export const directProcessContainment: CommandProcessContainment = {
  detached: false,
  signal(child, signal) {
    child.kill(signal);
  },
};

export const posixProcessGroupContainment: CommandProcessContainment = {
  detached: true,
  signal(child, signal) {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  },
};
