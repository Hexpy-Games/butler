import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type PackagedProcessRole =
  | "electron_main"
  | "electron_renderer"
  | "agent_runtime";

export interface PackagedProcessTarget {
  role: PackagedProcessRole;
  pid: number;
}

export interface PackagedProcessSample extends PackagedProcessTarget {
  cpuPercent: number | null;
  cpuTimeMs: number | null;
  rssBytes: number | null;
}

export interface PackagedProcessMeasurement extends PackagedProcessTarget {
  beforeCpuTimeMs: number;
  afterCpuTimeMs: number;
  cpuRatio: number;
  beforeRssBytes: number;
  afterRssBytes: number;
  rssGrowthBytes: number;
}

export interface DatabaseFileSample {
  relativePath: string;
  sizeBytes: number;
}

export interface PackagedPerformanceSnapshot {
  capturedAt: string;
  processes: PackagedProcessSample[];
  databases: DatabaseFileSample[];
}

export function capturePackagedPerformanceSnapshot(input: {
  butlerData: string;
  processTargets: PackagedProcessTarget[];
  capturedAt?: Date;
}): PackagedPerformanceSnapshot {
  return {
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    processes: input.processTargets.map(readProcessSample),
    databases: databaseFileSamples(input.butlerData),
  };
}

export function measurePackagedProcesses(
  before: PackagedPerformanceSnapshot,
  after: PackagedPerformanceSnapshot,
): PackagedProcessMeasurement[] {
  const elapsedMs = Date.parse(after.capturedAt) - Date.parse(before.capturedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return [];
  const afterByIdentity = new Map(
    after.processes.map((sample) => [processIdentity(sample), sample]),
  );
  return before.processes.flatMap((sample) => {
    const next = afterByIdentity.get(processIdentity(sample));
    if (
      !next ||
      sample.cpuTimeMs === null ||
      sample.rssBytes === null ||
      next.cpuTimeMs === null ||
      next.rssBytes === null
    ) {
      return [];
    }
    const cpuTimeMs = Math.max(0, next.cpuTimeMs - sample.cpuTimeMs);
    return [{
      role: sample.role,
      pid: sample.pid,
      beforeCpuTimeMs: sample.cpuTimeMs,
      afterCpuTimeMs: next.cpuTimeMs,
      cpuRatio: cpuTimeMs / elapsedMs,
      beforeRssBytes: sample.rssBytes,
      afterRssBytes: next.rssBytes,
      rssGrowthBytes: next.rssBytes - sample.rssBytes,
    }];
  });
}

export function requiredProcessRolesMeasured(
  measurements: PackagedProcessMeasurement[],
): Record<PackagedProcessRole, boolean> {
  return {
    electron_main: measurements.some((sample) => sample.role === "electron_main"),
    electron_renderer: measurements.some((sample) => sample.role === "electron_renderer"),
    agent_runtime: measurements.some((sample) => sample.role === "agent_runtime"),
  };
}

function readProcessSample(target: PackagedProcessTarget): PackagedProcessSample {
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0) {
    return { ...target, cpuPercent: null, cpuTimeMs: null, rssBytes: null };
  }
  try {
    const output = execFileSync(
      "ps",
      ["-o", "%cpu=", "-o", "rss=", "-o", "time=", "-p", String(target.pid)],
      { encoding: "utf8" },
    ).trim();
    const [cpuText, rssKiBText, cpuTimeText] = output.split(/\s+/u);
    const cpu = Number(cpuText);
    const rssKiB = Number(rssKiBText);
    return {
      ...target,
      cpuPercent: finiteOrNull(cpu),
      cpuTimeMs: parseCpuTimeMs(cpuTimeText),
      rssBytes: Number.isFinite(rssKiB) ? rssKiB! * 1024 : null,
    };
  } catch {
    return { ...target, cpuPercent: null, cpuTimeMs: null, rssBytes: null };
  }
}

function databaseFileSamples(butlerData: string): DatabaseFileSample[] {
  return listDatabaseFiles(butlerData)
    .map((path) => ({
      relativePath: relative(butlerData, path).replaceAll("\\", "/"),
      sizeBytes: statSync(path).size,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function listDatabaseFiles(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return listDatabaseFiles(path);
      if (!entry.isFile() || !isDatabaseFile(entry.name)) return [];
      return [path];
    });
  } catch {
    return [];
  }
}

function isDatabaseFile(name: string): boolean {
  return /\.(?:sqlite3?|db)(?:-(?:wal|shm))?$/u.test(name);
}

function processIdentity(sample: PackagedProcessTarget): string {
  return `${sample.role}:${sample.pid}`;
}

function parseCpuTimeMs(value: string | undefined): number | null {
  if (!value) return null;
  const [dayText, clockText] = value.includes("-")
    ? value.split("-", 2)
    : ["0", value];
  const clock = clockText!.split(":").map(Number);
  const seconds = clock.pop();
  const minutes = clock.pop() ?? 0;
  const hours = clock.pop() ?? 0;
  const days = Number(dayText);
  if (![days, hours, minutes, seconds].every(Number.isFinite)) return null;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds!) * 1_000;
}

function finiteOrNull(value: number | undefined): number | null {
  return Number.isFinite(value) ? value! : null;
}
