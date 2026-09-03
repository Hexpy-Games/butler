import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandStep } from "./contracts.ts";

/** macOS OS protection for model-authored commands, including descendants. */
export function protectProgramFiles(step: CommandStep, programHome?: string): CommandStep {
  if (!programHome) return step;
  const path = resolve(programHome);
  const paths = [...new Set([path, existsSync(path) ? realpathSync(path) : path])];
  if (process.platform === "darwin") {
    return {
      executable: "/usr/bin/sandbox-exec",
      arguments: [
        "-p",
        `(version 1)(allow default)(deny file-write* ${paths.map((root) => `(subpath ${JSON.stringify(root)})`).join(" ")})`,
        step.executable,
        ...step.arguments ?? [],
      ],
    };
  }
  // Do not introduce a new external command dependency into other runtimes.
  // Their cwd and native file tools use the same data-only storage contract.
  return step;
}
