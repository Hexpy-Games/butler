import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";

const FILE_LOCK_STALE_MS = 30_000;
const FILE_LOCK_WAIT_TIMEOUT_MS = 1_000;
const FILE_LOCK_RETRY_DELAY_MS = 10;

function errnoCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isStaleLock(lockDir: string, now: number): boolean {
  try {
    return now - statSync(lockDir).mtimeMs >= FILE_LOCK_STALE_MS;
  } catch {
    return true;
  }
}

function uniqueTempPath(targetPath: string): string {
  const dir = dirname(targetPath);
  const name = basename(targetPath);
  const random = Math.random().toString(36).slice(2);
  return join(dir, `.${name}.tmp-${process.pid}-${Date.now()}-${random}`);
}

export function atomicWriteTextFile(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = uniqueTempPath(path);
  const fd = openSync(tempPath, "wx");
  let closed = false;
  const closeFile = (): void => {
    if (closed) return;
    closeSync(fd);
    closed = true;
  };

  try {
    writeFileSync(fd, value, "utf8");
    fsyncSync(fd);
    closeFile();
    renameSync(tempPath, path);
  } catch (error) {
    closeFile();
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function withFileLock<T>(targetPath: string, write: () => T): T {
  const lockDir = `${targetPath}.lock`;
  const startedAt = Date.now();

  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
      const now = Date.now();
      if (isStaleLock(lockDir, now)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (now - startedAt >= FILE_LOCK_WAIT_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for file lock: ${targetPath}`, { cause: error });
      }
      sleepSync(FILE_LOCK_RETRY_DELAY_MS);
    }
  }

  try {
    return write();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function writeLockedTextFile(path: string, value: string): void {
  withFileLock(path, () => atomicWriteTextFile(path, value));
}
