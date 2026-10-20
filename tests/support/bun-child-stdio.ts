import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";

const retainedChildren = new Set<ChildProcess>();
let installed = false;

export function installBunChildStdioRetention(): void {
  if (typeof Bun === "undefined" || installed) return;
  const childProcess: typeof import("node:child_process") = createRequire(import.meta.url)("node:child_process");
  const original = childProcess.spawn;
  childProcess.spawn = ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, options?: SpawnOptions) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : undefined;
    const spawnOptions = argsOrOptions === undefined || args ? options : argsOrOptions as SpawnOptions;
    const child = original(command, args ?? [], spawnOptions ?? {});
    // Bun 1.3.11 closes extra pipe fds again at ChildProcess GC, after exit (#1263).
    // Keep these children for the process lifetime: releasing on exit still corrupts reused fds.
    if (Array.isArray(spawnOptions?.stdio) && spawnOptions.stdio.length > 3) retainedChildren.add(child);
    return child;
  }) as typeof childProcess.spawn;
  installed = true;
}

installBunChildStdioRetention();
