import {
  appendFileSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";

const FILE_LOCK_STALE_MS = 30_000;
const FILE_LOCK_WAIT_TIMEOUT_MS = 1_000;
const FILE_LOCK_RETRY_DELAY_MS = 10;
const FILE_LOCK_OWNER_FILE = "owner.json";

interface FileLockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

function errnoCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

function recordFileStateEvidence(event: string, payload: Record<string, unknown>): void {
  const evidencePath = process.env.BUTLER_FILE_STATE_EVIDENCE_PATH?.trim();
  if (!evidencePath) return;
  try {
    mkdirSync(dirname(evidencePath), { recursive: true });
    appendFileSync(evidencePath, `${JSON.stringify({
      schema: "butler.file-state-evidence.v1",
      event,
      at: new Date().toISOString(),
      pid: process.pid,
      ...payload,
    })}\n`, "utf8");
  } catch {
    // Evidence logging is test-only and must never change state-write behavior.
  }
}

function isLockExistsError(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "EEXIST" || code === "ENOTEMPTY";
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

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

function readLockOwner(lockPath: string): FileLockOwner | null {
  try {
    const stat = statSync(lockPath);
    const ownerText = stat.isDirectory()
      ? readFileSync(join(lockPath, FILE_LOCK_OWNER_FILE), "utf8")
      : readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(ownerText) as FileLockOwner;
    if (
      typeof parsed?.pid === "number" &&
      typeof parsed.token === "string" &&
      typeof parsed.acquiredAt === "string"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function canRecoverLock(lockPath: string, now: number): boolean {
  if (!isStaleLock(lockPath, now)) return false;
  const owner = readLockOwner(lockPath);
  return owner !== null && !isPidAlive(owner.pid);
}

function uniqueTempPath(targetPath: string): string {
  const dir = dirname(targetPath);
  const name = basename(targetPath);
  const random = Math.random().toString(36).slice(2);
  return join(dir, `.${name}.tmp-${process.pid}-${Date.now()}-${random}`);
}

function tempPathPrefix(targetPath: string): string {
  return `.${basename(targetPath)}.tmp-`;
}

function lockCandidatePath(lockPath: string): string {
  const random = Math.random().toString(36).slice(2);
  return join(dirname(lockPath), `.${basename(lockPath)}.candidate-${process.pid}-${Date.now()}-${random}`);
}

function lockCandidatePrefix(lockPath: string): string {
  return `.${basename(lockPath)}.candidate-`;
}

function cleanupTempFiles(targetPath: string): void {
  const dir = dirname(targetPath);
  const prefix = tempPathPrefix(targetPath);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(prefix)) {
      rmSync(join(dir, entry), { force: true });
    }
  }
}

function cleanupStaleLockCandidates(lockPath: string, now: number): void {
  const dir = dirname(lockPath);
  const prefix = lockCandidatePrefix(lockPath);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const path = join(dir, entry);
    try {
      if (now - statSync(path).mtimeMs >= FILE_LOCK_STALE_MS) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

export function atomicWriteTextFile(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = uniqueTempPath(path);
  recordFileStateEvidence("atomic_write.started", {
    target: basename(path),
    bytes: Buffer.byteLength(value, "utf8"),
  });
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
    recordFileStateEvidence("atomic_write.committed", {
      target: basename(path),
      bytes: Buffer.byteLength(value, "utf8"),
    });
  } catch (error) {
    closeFile();
    rmSync(tempPath, { force: true });
    recordFileStateEvidence("atomic_write.failed", {
      target: basename(path),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function acquireFileLock(lockPath: string): string {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const candidatePath = lockCandidatePath(lockPath);
  try {
    atomicWriteTextFile(candidatePath, `${JSON.stringify({
      pid: process.pid,
      token,
      acquiredAt: new Date().toISOString(),
    } satisfies FileLockOwner)}\n`);
    linkSync(candidatePath, lockPath);
  } catch (error) {
    rmSync(candidatePath, { force: true });
    throw error;
  }
  rmSync(candidatePath, { force: true });
  recordFileStateEvidence("lock.acquired", {
    lock: basename(lockPath),
    token,
  });
  return token;
}

function releaseFileLock(lockPath: string, token: string): void {
  if (readLockOwner(lockPath)?.token !== token) return;
  rmSync(lockPath, { recursive: true, force: true });
  recordFileStateEvidence("lock.released", {
    lock: basename(lockPath),
    token,
  });
}

export function withFileLock<T>(targetPath: string, write: () => T): T {
  const lockPath = `${targetPath}.lock`;
  const token = waitForFileLock(targetPath, lockPath);

  try {
    cleanupTempFiles(targetPath);
    return write();
  } finally {
    releaseFileLock(lockPath, token);
  }
}

function waitForFileLock(targetPath: string, lockPath: string): string {
  const startedAt = Date.now();

  while (true) {
    try {
      cleanupStaleLockCandidates(lockPath, Date.now());
      return acquireFileLock(lockPath);
    } catch (error) {
      if (!isLockExistsError(error)) throw error;
      const now = Date.now();
      if (canRecoverLock(lockPath, now)) {
        rmSync(lockPath, { recursive: true, force: true });
        recordFileStateEvidence("lock.recovered", {
          target: basename(targetPath),
          lock: basename(lockPath),
        });
        continue;
      }
      if (now - startedAt >= FILE_LOCK_WAIT_TIMEOUT_MS) {
        recordFileStateEvidence("lock.timeout", {
          target: basename(targetPath),
          lock: basename(lockPath),
        });
        throw new Error(`Timed out waiting for file lock: ${targetPath}`, { cause: error });
      }
      sleepSync(FILE_LOCK_RETRY_DELAY_MS);
    }
  }
}

export function writeLockedTextFile(path: string, value: string): void {
  withFileLock(path, () => atomicWriteTextFile(path, value));
}
