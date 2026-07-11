import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { withDurableFileLock, type DurableLockLease } from "../../packages/butler-agent/src/agent/persistence/atomic-json-store.ts";
import {
  MUTATION_LOCK_SHARD_COUNT,
  MUTATION_LOCK_SHARD_DIRECTORY,
  sqliteMutationLockPath,
  sqliteMutationLockShardPaths,
} from "../../packages/butler-agent/src/agent/persistence/sqlite-mutation-lock.ts";

let data = "";
beforeEach(() => {
  data = join(tmpdir(), `butler-sqlite-lock-${Date.now()}-${Math.random()}`);
  mkdirSync(data, { recursive: true });
});
afterEach(() => rmSync(data, { recursive: true, force: true }));

test("live SQLite ownership ignores wall-clock changes and supports renewal", () => {
  const lockPath = join(data, "fake-clock.lock");
  const outer = withDurableFileLock({
    lockPath,
    ownerId: "live-owner",
    now: new Date("2026-07-10T00:00:00.000Z"),
    action: (lease) => {
      expect(lease.renew(new Date("2099-01-01T00:00:00.000Z"))).toBe(true);
      expect(withDurableFileLock({
        lockPath,
        ownerId: "replacement",
        now: new Date("2199-01-01T00:00:00.000Z"),
        busyTimeoutMs: 10,
        action: () => true,
      })).toBeNull();
      return lease.fencingGeneration;
    },
  });
  expect(outer).toBe(1);
});

test("an old SQLite lease cannot affect its replacement owner", () => {
  const lockPath = join(data, "replacement-owner.lock");
  let oldLease: DurableLockLease | null = null;
  expect(withDurableFileLock({ lockPath, ownerId: "old-owner", action: (lease) => {
    oldLease = lease;
    return true;
  } })).toBe(true);
  expect(withDurableFileLock({ lockPath, ownerId: "replacement-owner", action: (replacement) => {
    expect(oldLease?.isOwned()).toBe(false);
    expect(oldLease?.renew()).toBe(false);
    expect(replacement.isOwned()).toBe(true);
    return true;
  } })).toBe(true);
});

test("legacy v1 v2 and fence artifacts migrate without consulting PID", () => {
  const lockPath = join(data, "legacy.lock");
  writeFileSync(lockPath, JSON.stringify({ schema_version: "butler.durable-lock.v1", process_id: process.pid }));
  expect(withDurableFileLock({ lockPath, ownerId: "first-sqlite-owner", action: (lease) => lease.fencingGeneration })).toBe(1);
  expect(existsSync(lockPath)).toBe(false);
  writeFileSync(lockPath, JSON.stringify({
    schema_version: "butler.durable-lock.v2",
    owner_id: "legacy-owner",
    ownership_token: "legacy-token",
    process_id: process.pid,
    fencing_generation: 99,
  }));
  writeFileSync(`${lockPath}.fence.json`, JSON.stringify({ schema_version: "butler.lock-fence.v1", generation: 99 }));
  expect(withDurableFileLock({ lockPath, ownerId: "second-sqlite-owner", action: (lease) => lease.fencingGeneration })).toBe(2);
  expect(existsSync(lockPath)).toBe(false);
  expect(existsSync(`${lockPath}.fence.json`)).toBe(false);
  writeFileSync(`${lockPath}.sqlite3`, "legacy sqlite placeholder");
  writeFileSync(`${lockPath}.sqlite3-wal`, "legacy wal placeholder");
  writeFileSync(`${lockPath}.sqlite3-shm`, "legacy shm placeholder");
  expect(withDurableFileLock({ lockPath, ownerId: "third-sqlite-owner", action: () => true })).toBe(true);
  expect(existsSync(`${lockPath}.sqlite3`)).toBe(false);
  expect(existsSync(`${lockPath}.sqlite3-wal`)).toBe(false);
  expect(existsSync(`${lockPath}.sqlite3-shm`)).toBe(false);
});

test("shard storage rejects logical paths outside its root and symlinked lock directories", () => {
  const outside = join(tmpdir(), `butler-outside-lock-${Date.now()}-${Math.random()}`);
  expect(() => withDurableFileLock({
    lockPath: join(outside, "outside.lock"),
    lockRoot: data,
    ownerId: "outside-owner",
    action: () => true,
  })).toThrow("sqlite_mutation_lock_path_outside_root");
  mkdirSync(join(data, "redirect"));
  symlinkSync(join(data, "redirect"), join(data, "runtime"));
  expect(() => withDurableFileLock({
    lockPath: join(data, "inside.lock"),
    lockRoot: data,
    ownerId: "symlink-owner",
    action: () => true,
  })).toThrow("sqlite_mutation_lock_directory_symlink");
});

test("legacy cleanup rejects symlinked or junction logical parents", () => {
  const outside = join(tmpdir(), `butler-lock-cleanup-outside-${Date.now()}-${Math.random()}`);
  mkdirSync(outside, { recursive: true });
  try {
    const links = join(data, "links");
    mkdirSync(links, { recursive: true });
    symlinkSync(outside, join(links, "escape"), process.platform === "win32" ? "junction" : "dir");
    const victim = join(outside, "victim.lock");
    writeFileSync(victim, "must remain outside");
    expect(() => withDurableFileLock({
      lockPath: join(links, "escape", "victim.lock"),
      lockRoot: data,
      ownerId: "logical-parent-escape",
      action: () => true,
    })).toThrow("sqlite_mutation_lock_logical_parent_symlink");
    expect(readFileSync(victim, "utf8")).toBe("must remain outside");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("10k logical lock keys use a fixed set of private shard databases", () => {
  for (let index = 0; index < 10_000; index += 1) {
    const lockPath = join(data, "logical-locks", `${index}.lock`);
    expect(withDurableFileLock({ lockPath, lockRoot: data, ownerId: `owner-${index}`, action: () => true })).toBe(true);
  }
  const shardPaths = sqliteMutationLockShardPaths(data);
  expect(shardPaths).toHaveLength(MUTATION_LOCK_SHARD_COUNT);
  expect(shardPaths.every(existsSync)).toBe(true);
  const shardDirectory = join(data, "runtime", MUTATION_LOCK_SHARD_DIRECTORY);
  expect(statSync(shardDirectory).mode & 0o777).toBe(0o700);
  expect(readdirSync(shardDirectory).filter((name) => name.endsWith(".sqlite3"))).toHaveLength(MUTATION_LOCK_SHARD_COUNT);
  for (const path of shardPaths) {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const db = new Database(path, { readonly: true, strict: true });
    try {
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM active_lock").get()?.count).toBe(0);
      expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    } finally {
      db.close(false);
    }
  }
}, 120_000);

test("production contention is fail-fast and does not stall an event-loop timer", async () => {
  const fixture = join(process.cwd(), "tests", "support", "sqlite-lock-contender.ts");
  const lockPath = join(data, "event-loop.lock");
  const logPath = join(data, "event-loop.jsonl");
  expect(withDurableFileLock({ lockPath, lockRoot: data, ownerId: "initializer", action: () => true })).toBe(true);
  const holder = spawnContender(fixture, lockPath, logPath, "holder", 30_000, 30_000, data);
  await waitForEntry(logPath);
  const startedAt = performance.now();
  const timer = new Promise<number>((resolveTimer) => setTimeout(() => resolveTimer(performance.now() - startedAt), 0));
  for (let index = 0; index < 100; index += 1) {
    expect(withDurableFileLock({ lockPath, lockRoot: data, ownerId: `blocked-${index}`, action: () => true })).toBeNull();
  }
  expect(await timer).toBeLessThan(250);
  holder.kill("SIGKILL");
  await holder.exited;
}, 30_000);

test("SQLite ownership serializes 64 processes and recovers two contenders after SIGKILL", async () => {
  const fixture = join(process.cwd(), "tests", "support", "sqlite-lock-contender.ts");
  const lockPath = join(data, "contention.lock");
  const logPath = join(data, "contention.jsonl");
  expect(withDurableFileLock({ lockPath, ownerId: "initializer", action: () => true })).toBe(true);
  const contenders = Array.from({ length: 64 }, (_, index) => spawnContender(fixture, lockPath, logPath, `owner-${index}`, 3, 30_000));
  expect(await Promise.all(contenders.map((child) => child.exited))).toEqual(Array(64).fill(0));
  const events = readEvents(logPath);
  const summary = concurrencySummary(events);
  expect(events).toHaveLength(128);
  expect(new Set(events.filter((event) => event.event === "enter").map((event) => event.ownerId)).size).toBe(64);
  expect(summary).toEqual({ active: 0, max: 1 });
  expect(events.filter((event) => event.event === "enter").map((event) => event.fencingGeneration))
    .toEqual(Array.from({ length: 64 }, (_, index) => index + 2));
  expect(existsSync(sqliteMutationLockPath(lockPath))).toBe(true);

  const recoveryLock = join(data, "killed-owner.lock");
  const recoveryLog = join(data, "killed-owner.jsonl");
  const killed = spawnContender(fixture, recoveryLock, recoveryLog, "killed-owner", 60_000, 30_000);
  await waitForEntry(recoveryLog);
  const recoveryShard = sqliteMutationLockPath(recoveryLock);
  expect(existsSync(recoveryShard)).toBe(true);
  killed.kill("SIGKILL");
  await killed.exited;
  const recoveryOwners = ["recovery-owner-a", "recovery-owner-b"];
  const recoverers = recoveryOwners.map((owner) => spawnContender(fixture, recoveryLock, recoveryLog, owner, 3, 10_000));
  expect(await Promise.all(recoverers.map((child) => child.exited))).toEqual([0, 0]);
  const recoveryEvents = readEvents(recoveryLog).filter((event) => recoveryOwners.includes(event.ownerId));
  expect(recoveryEvents).toHaveLength(4);
  expect(concurrencySummary(recoveryEvents)).toEqual({ active: 0, max: 1 });
  expect(existsSync(recoveryShard)).toBe(true);
}, 60_000);

interface LockEvent { event: "enter" | "exit"; ownerId: string; fencingGeneration: number }

function spawnContender(
  fixture: string,
  lockPath: string,
  logPath: string,
  owner: string,
  holdMs: number,
  timeoutMs: number,
  lockRoot?: string,
) {
  return Bun.spawn({
    cmd: [process.execPath, fixture, lockPath, logPath, owner, String(holdMs), String(timeoutMs), ...(lockRoot ? [lockRoot] : [])],
    cwd: process.cwd(),
    stdout: "ignore",
    stderr: "inherit",
  });
}

function readEvents(path: string): LockEvent[] {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function concurrencySummary(events: LockEvent[]): { active: number; max: number } {
  let active = 0;
  let max = 0;
  for (const event of events) {
    active += event.event === "enter" ? 1 : -1;
    expect(active).toBeGreaterThanOrEqual(0);
    max = Math.max(max, active);
  }
  return { active, max };
}

async function waitForEntry(logPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((!existsSync(logPath) || !readFileSync(logPath, "utf8").includes('"event":"enter"')) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(existsSync(logPath)).toBe(true);
  expect(readFileSync(logPath, "utf8")).toContain('"event":"enter"');
}
