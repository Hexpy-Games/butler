import { appendFileSync } from "fs";
import { withSqliteMutationLock } from "../../packages/butler-agent/src/agent/persistence/sqlite-mutation-lock.ts";

const [lockPath, logPath, ownerId, holdText, timeoutText, lockRoot] = process.argv.slice(2);
if (!lockPath || !logPath || !ownerId) throw new Error("sqlite_lock_contender_arguments_missing");
const holdMs = Math.max(0, Number.parseInt(holdText ?? "0", 10) || 0);
const busyTimeoutMs = Math.max(0, Number.parseInt(timeoutText ?? "30000", 10) || 30_000);

const acquired = withSqliteMutationLock({
  lockPath,
  lockRoot,
  ownerId,
  busyTimeoutMs,
  action: (lease) => {
    appendFileSync(logPath, `${JSON.stringify({ event: "enter", ownerId, fencingGeneration: lease.fencingGeneration })}\n`);
    if (holdMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
    appendFileSync(logPath, `${JSON.stringify({ event: "exit", ownerId, fencingGeneration: lease.fencingGeneration })}\n`);
    return true;
  },
});

if (acquired !== true) process.exitCode = 2;
