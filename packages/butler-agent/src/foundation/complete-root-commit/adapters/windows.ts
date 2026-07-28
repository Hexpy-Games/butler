import { existsSync } from "node:fs";
import { dlopen, FFIType, ptr } from "bun:ffi";
import type { CompleteRootCommitAdapter } from "../contracts.ts";

const MOVEFILE_WRITE_THROUGH = 0x8;

interface WindowsRootOperations {
  exists(path: string): boolean;
  move(source: string, target: string): void;
}

export const windowsCompleteRootCommit = createWindowsCompleteRootCommit({
  exists: existsSync,
  move: moveRoot,
});

export function createWindowsCompleteRootCommit(
  operations: WindowsRootOperations,
): CompleteRootCommitAdapter {
  const reconcileExchange = (stagedRoot: string, targetRoot: string): boolean => {
    const displacedRoot = displacedPath(stagedRoot);
    if (!operations.exists(displacedRoot)) return false;

    const stagedPresent = operations.exists(stagedRoot);
    const targetPresent = operations.exists(targetRoot);
    if (stagedPresent && targetPresent) {
      throw new Error("Windows complete-root commit has ambiguous recovery state");
    }
    if (!stagedPresent && !targetPresent) {
      throw new Error("Windows complete-root commit lost both candidate and target");
    }
    if (!targetPresent) operations.move(stagedRoot, targetRoot);
    if (!operations.exists(stagedRoot)) operations.move(displacedRoot, stagedRoot);
    return true;
  };

  return {
    reconcileExchange,
    exchange(stagedRoot, targetRoot) {
      if (reconcileExchange(stagedRoot, targetRoot)) return;
      requirePresent(operations, stagedRoot, "staged root");
      requirePresent(operations, targetRoot, "target root");
      const displacedRoot = displacedPath(stagedRoot);
      requireAbsent(operations, displacedRoot, "displaced root");

      operations.move(targetRoot, displacedRoot);
      try {
        operations.move(stagedRoot, targetRoot);
      } catch (error) {
        restoreTarget(operations, displacedRoot, targetRoot, error);
      }
      operations.move(displacedRoot, stagedRoot);
    },
    install(stagedRoot, absentTargetRoot) {
      requirePresent(operations, stagedRoot, "staged root");
      requireAbsent(operations, absentTargetRoot, "target root");
      operations.move(stagedRoot, absentTargetRoot);
    },
  };
}

function restoreTarget(
  operations: WindowsRootOperations,
  displacedRoot: string,
  targetRoot: string,
  commitError: unknown,
): never {
  try {
    operations.move(displacedRoot, targetRoot);
  } catch (rollbackError) {
    throw new AggregateError(
      [commitError, rollbackError],
      "Windows complete-root commit and rollback both failed",
      { cause: rollbackError },
    );
  }
  throw commitError;
}

function moveRoot(source: string, target: string): void {
  const library = dlopen("kernel32.dll", {
    MoveFileExW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  try {
    const sourcePath = Buffer.from(`${source}\0`, "utf16le");
    const targetPath = Buffer.from(`${target}\0`, "utf16le");
    const moved = library.symbols.MoveFileExW(
      ptr(sourcePath),
      ptr(targetPath),
      MOVEFILE_WRITE_THROUGH,
    );
    if (moved === 0) {
      throw new Error(
        `Windows complete-root move failed with code ${library.symbols.GetLastError()}`,
      );
    }
  } finally {
    library.close();
  }
}

function displacedPath(stagedRoot: string): string {
  return `${stagedRoot}.btcc-displaced`;
}

function requirePresent(
  operations: WindowsRootOperations,
  path: string,
  label: string,
): void {
  if (!operations.exists(path)) throw new Error(`Complete-root ${label} is missing`);
}

function requireAbsent(
  operations: WindowsRootOperations,
  path: string,
  label: string,
): void {
  if (operations.exists(path)) throw new Error(`Complete-root ${label} already exists`);
}
