import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { ensureDir, ledgerRoot } from "./fs.js";

const heldMutationLocks = new Set();

export function mutationLockPath(project) {
  const root = ledgerRoot(project);
  return join(dirname(root), ".project-ledger-locks", `${basename(root)}.lock`);
}

export function withProjectLedgerMutation(project, mutation) {
  const path = mutationLockPath(project);
  if (heldMutationLocks.has(path)) return mutation();
  const owner = currentMutationOwner();
  acquireMutationClaim(path, owner);
  try {
    heldMutationLocks.add(path);
    return mutation();
  } finally {
    heldMutationLocks.delete(path);
    releaseExactClaim(path, owner);
  }
}

export function tryCreateClaim(path, owner) {
  ensureDir(dirname(path));
  const candidate = `${path}.candidate-${randomUUID()}`;
  writeFileSync(candidate, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx" });
  try {
    linkSync(candidate, path);
    return true;
  } catch (error) {
    if (!isExistingPath(error)) throw error;
    return false;
  } finally {
    rmSync(candidate, { force: true });
  }
}

export function readClaim(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const legacyOwner = join(path, "owner.json");
    if (existsSync(legacyOwner)) return JSON.parse(readFileSync(legacyOwner, "utf8"));
    throw new Error("Project Ledger claim has no readable owner identity", { cause: error });
  }
}

export function releaseExactClaim(path, expected) {
  const actual = readClaim(path);
  if (!actual || actual.claimId !== expected.claimId) {
    throw new Error("Project Ledger claim ownership changed before release");
  }
  rmSync(path, { recursive: true });
}

function acquireMutationClaim(path, owner) {
  while (!tryCreateClaim(path, owner)) {
    const existing = readClaim(path);
    if (existing?.schema === "project-ledger.publication-claim.v1") {
      throw new Error("Project Ledger mutation is blocked by an active publication");
    }
    if (!isDeadMutationOwner(existing)) {
      throw new Error("Project Ledger mutation is blocked by an active claim");
    }
    quarantineExactDeadClaim(path, existing);
  }
}

function quarantineExactDeadClaim(path, expected) {
  const quarantine = `${path}.dead-${expected.claimId}`;
  try {
    renameSync(path, quarantine);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  const quarantined = readClaim(quarantine);
  if (quarantined?.claimId !== expected.claimId) {
    throw new Error("Project Ledger dead-claim identity changed during recovery");
  }
  rmSync(quarantine, { recursive: true });
}

function currentMutationOwner() {
  const observed = observeProcessStartedAtMs(process.pid);
  const startedAtMs = typeof observed === "number"
    ? observed
    : Math.floor((Date.now() - process.uptime() * 1_000) / 1_000) * 1_000;
  return {
    schema: "project-ledger.mutation-claim.v1",
    claimId: randomUUID(),
    hostId: hostname(),
    processId: process.pid,
    processStartedAtMs: startedAtMs,
  };
}

function isDeadMutationOwner(owner) {
  if (owner?.schema !== "project-ledger.mutation-claim.v1") return false;
  if (owner.hostId !== hostname()) return false;
  const observed = observeProcessStartedAtMs(owner.processId);
  return observed === "missing" ||
    (typeof observed === "number" && observed !== owner.processStartedAtMs);
}

function observeProcessStartedAtMs(processId) {
  const result = spawnSync("ps", ["-p", String(processId), "-o", "lstart="], {
    encoding: "utf8",
  });
  if (result.error) return observeMissingProcess(processId);
  if (result.status === 1 && result.stdout.trim() === "") return "missing";
  if (result.status !== 0) return null;
  const startedAtMs = Date.parse(result.stdout.trim());
  return Number.isFinite(startedAtMs) ? startedAtMs : null;
}

function observeMissingProcess(processId) {
  try {
    process.kill(processId, 0);
    return null;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH"
      ? "missing"
      : null;
  }
}

function isExistingPath(error) {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissingPath(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
