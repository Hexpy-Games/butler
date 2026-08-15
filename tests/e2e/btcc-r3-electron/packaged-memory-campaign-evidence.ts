import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { PreparedRun } from "./contracts.ts";
import type {
  PackagedPerformanceSnapshot,
  PackagedProcessRole,
} from "../../support/packaged-performance-snapshot.ts";

export const PACKAGED_MEMORY_CACHE_POLICY = "fresh-isolated-runtime-model-cache-v1" as const;
export const SOURCE_FINGERPRINT_MAX_UNTRACKED_BYTES = 128 * 1024 * 1024;
export const PORTABLE_EVIDENCE_LABEL_MAX_LENGTH = 64;

export interface PackagedMemoryGuardEvidence {
  schema?: string;
  ok: boolean;
  reason: string;
  attempts: number;
  successes: number;
  /** Bounded executable basename; the local absolute path never leaves the run. */
  executableLabel?: string;
  /** Stable hash of the local executable path for diagnostics/comparison. */
  executableFingerprint?: string;
  bunVersion?: string;
  /** Bounded command shape; raw args and paths remain local-only. */
  commandLabel?: string;
  /** Stable hash of the local command vector for diagnostics/comparison. */
  commandFingerprint?: string;
}

export interface PortableGuardIdentity {
  executableLabel?: string;
  executableFingerprint?: string;
  commandLabel?: string;
  commandFingerprint?: string;
}

export function portableExecutableLabel(executable: string | null | undefined): string {
  if (!executable) return "";
  const value = basename(executable.replaceAll("\\", "/"));
  return boundedPortableLabel(value);
}

export function portableCommandLabel(commandLabel: string | null | undefined): string {
  if (!commandLabel) return "";
  const match = /^(.+?)\+(\d{1,3})args$/u.exec(commandLabel.trim());
  if (!match) return "command";
  const executable = portableExecutableLabel(match[1]);
  const argumentCount = Math.min(99, Number(match[2]));
  return boundedPortableLabel(`${executable || "command"}+${argumentCount}args`);
}

export function portableValueFingerprint(value: string | null | undefined): string {
  if (!value) return "";
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function portableGuardIdentity(input: {
  bunExecutable?: string | null;
  command?: readonly string[] | null;
}): PortableGuardIdentity {
  const executableLabel = portableExecutableLabel(input.bunExecutable);
  const executableFingerprint = portableValueFingerprint(input.bunExecutable);
  const command = input.command?.length ? [...input.command] : [];
  const commandLabel = command.length > 0
    ? boundedPortableLabel(
        `${portableExecutableLabel(command[0]) || "command"}+${Math.min(command.length - 1, 99)}args`,
      )
    : "";
  const commandFingerprint = portableValueFingerprint(command.join("\0"));
  return {
    ...(executableLabel ? { executableLabel } : {}),
    ...(executableFingerprint ? { executableFingerprint } : {}),
    ...(commandLabel ? { commandLabel } : {}),
    ...(commandFingerprint ? { commandFingerprint } : {}),
  };
}

function boundedPortableLabel(value: string): string {
  return value
    .replaceAll(/[\r\n]/gu, "")
    .replaceAll(String.fromCharCode(0), "")
    .slice(0, PORTABLE_EVIDENCE_LABEL_MAX_LENGTH);
}

/**
 * Privacy-safe per-role physical-memory diagnostics for the RMF gate. PIDs and
 * command lines remain in the local run, while portable evidence keeps only
 * stable role/label identities and sampled bytes.
 */
export interface CampaignRolePhysicalMemorySeries {
  role: PackagedProcessRole;
  label: string | null;
  samples: Array<{
    phase: "warmup" | "steady" | "idle" | "unknown";
    cycleIndex: number;
    physicalFootprintBytes: number | null;
    privateResidentBytes: number | null;
    rssBytes: number | null;
  }>;
}

export function summarizeRolePhysicalMemorySeries(
  cycles: readonly PackagedPerformanceSnapshot[],
): CampaignRolePhysicalMemorySeries[] {
  const series = new Map<string, CampaignRolePhysicalMemorySeries>();
  for (const [fallbackIndex, cycle] of cycles.entries()) {
    const phase = cycle.cycle?.phase ?? "unknown";
    const cycleIndex = cycle.cycle?.index ?? fallbackIndex;
    for (const sample of cycle.processes) {
      const key = `${sample.role}:${sample.label ?? ""}`;
      const entry = series.get(key) ?? {
        role: sample.role,
        label: sample.label ?? null,
        samples: [],
      };
      entry.samples.push({
        phase,
        cycleIndex,
        physicalFootprintBytes: sample.physicalFootprintBytes,
        privateResidentBytes: sample.privateResidentBytes,
        rssBytes: sample.rssBytes,
      });
      series.set(key, entry);
    }
  }
  return [...series.values()].sort((left, right) =>
    `${left.role}:${left.label ?? ""}`.localeCompare(`${right.role}:${right.label ?? ""}`),
  );
}

export function fingerprint(parts: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const [key, value] of Object.entries(parts).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`${key}\0${value}\0`);
  }
  return hash.digest("hex");
}

export function digestFixturePath(root: string): string {
  const hash = createHash("sha256");
  const visit = (path: string, relative: string): void => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry), join(relative, entry));
      return;
    }
    hash.update(`${relative}\0${readFileSync(path)}\0`);
  };
  visit(root, "fixture");
  return hash.digest("hex");
}

export function digestSeededHistory(dbPath: string, sessionId: string): string {
  const hash = createHash("sha256");
  // bun:sqlite is intentionally loaded by the campaign's existing runtime;
  // this module only owns the canonical logical-row digest policy.
  const database = new Database(dbPath, { readonly: true });
  try {
    const rows = database.query<{ role: string; text: string; status: string }, [string]>(
      "SELECT role, text, status FROM messages WHERE chat_id = ? ORDER BY rowid",
    ).all(sessionId);
    hash.update(`count\0${rows.length}\0`);
    for (const row of rows) hash.update(`${row.role}\0${row.status}\0${row.text}\0`);
  } finally {
    database.close();
  }
  return hash.digest("hex");
}

export function digestRuntimeCacheResource(root: string): string {
  const hash = createHash("sha256");
  const visit = (path: string, relative: string): void => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry), join(relative, entry));
      return;
    }
    if (relative.endsWith("/bin/bun") || relative.endsWith("/bin/bun.exe")) return;
    hash.update(`${relative}\0${readFileSync(path)}\0`);
  };
  visit(root, "runtime-resource");
  return hash.digest("hex");
}

export function digestModelCacheCandidates(candidates: readonly string[]): string {
  const existing = candidates
    .filter((candidate) => existsSync(candidate) && statSync(candidate).isDirectory())
    .sort();
  if (existing.length === 0) return "";
  return fingerprint({
    cacheDirectories: existing.map((candidate) => digestFixturePath(candidate)).join(","),
  });
}

export function modelCacheCandidates(managedExecutable: string | null): string[] {
  if (!managedExecutable) return [];
  const runtimeHome = managedRuntimeHomeFromExecutable(managedExecutable);
  if (!runtimeHome) return [];
  return [
    join(runtimeHome, "node_modules", "@huggingface", "transformers", ".cache"),
  ];
}

export function managedRuntimeHomeFromExecutable(executable: string): string | null {
  let runtimeHome = executable;
  for (let depth = 0; depth < 6; depth += 1) runtimeHome = dirname(runtimeHome);
  return runtimeHome;
}

export function computeSourceFingerprint(repoRoot: string): { fingerprint: string; error?: string } {
  const hash = createHash("sha256");
  try {
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    }).trim();
    hash.update(`tree\0${tree}\0`);
    const diff = execFileSync("git", ["diff", "--no-ext-diff", "--binary", "HEAD"], {
      cwd: repoRoot,
      encoding: "buffer",
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    hash.update("diff\0");
    hash.update(diff);
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    let untrackedBytes = 0;
    for (const relative of untracked.split("\0").filter(Boolean).sort()) {
      const path = resolve(repoRoot, relative);
      if (path !== resolve(repoRoot) && !path.startsWith(`${resolve(repoRoot)}/`)) {
        throw new Error(`untracked path escaped repository root: ${relative}`);
      }
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      const before = statSync(path);
      untrackedBytes += before.size;
      if (untrackedBytes > SOURCE_FINGERPRINT_MAX_UNTRACKED_BYTES) {
        throw new Error(`untracked source exceeded ${SOURCE_FINGERPRINT_MAX_UNTRACKED_BYTES} byte bound`);
      }
      hash.update(`untracked\0${relative}\0`);
      hash.update(readFileSync(path));
      const after = statSync(path);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error(`untracked source changed while fingerprinting: ${relative}`);
      }
    }
    return { fingerprint: hash.digest("hex") };
  } catch {
    return {
      fingerprint: "",
      // Keep the evidence privacy-safe. Git errors may contain absolute
      // worktree paths or filenames; the campaign reports only this stable
      // diagnostic and a typed campaign error code.
      error: "source fingerprint unavailable",
    };
  }
}

export function managedRuntimeExecutablePath(run: Pick<PreparedRun, "dataRoot">): string | null {
  const pointerPath = join(run.dataRoot, "app", "runtime", "agent", "current.json");
  if (!existsSync(pointerPath)) return null;
  try {
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { runtime_home?: unknown };
    if (typeof pointer.runtime_home !== "string" || !pointer.runtime_home.trim() ||
      pointer.runtime_home.startsWith("/") || pointer.runtime_home.includes("..")) return null;
    const executable = join(
      run.dataRoot,
      pointer.runtime_home,
      "packages",
      "butler-agent",
      "resources",
      "runtime",
      "bin",
      process.platform === "win32" ? "bun.exe" : "bun",
    );
    return existsSync(executable) ? executable : null;
  } catch {
    return null;
  }
}

export function executableVersion(executable: string | null): string {
  if (!executable) return "";
  try {
    return execFileSync(executable, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  } catch {
    return "";
  }
}

export function executableName(executable: string | null): string {
  return portableExecutableLabel(executable);
}
