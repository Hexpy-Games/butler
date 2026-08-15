import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturePackagedPerformanceSnapshot,
  type PackagedProcessTarget,
  type PackagedPerformanceSnapshot,
  type PackagedProcessSample,
} from "../support/packaged-performance-snapshot.ts";
import { evaluatePhysicalMemoryGate } from "../support/physical-memory-gate.ts";
import { runPackagedPerformanceReportCli } from
  "../support/packaged-performance-report.ts";
import {
  type ElectronForwardProgressBenchmark,
  snapshotLedgerRecords,
} from "../support/turn-forward-progress-electron-benchmark.ts";

const temporaryRoots: string[] = [];
const processTargets: PackagedProcessTarget[] = [
  { role: "electron_main", pid: process.pid },
  { role: "electron_renderer", pid: process.pid },
  { role: "agent_runtime", pid: process.pid },
];

function continuityCycle(
  index: number,
  targets: PackagedProcessTarget[],
  platform: "darwin" | "linux" = "darwin",
  source: "physical_footprint" | "private_resident" = "physical_footprint",
): PackagedPerformanceSnapshot {
  const processes: PackagedProcessSample[] = targets.map((target) => ({
    ...target,
    cpuPercent: 0,
    cpuTimeMs: 1,
    rssBytes: 100,
    virtualSizeBytes: 100,
    physicalFootprintBytes: source === "physical_footprint" ? 100 : null,
    privateResidentBytes: source === "private_resident" ? 100 : 100,
    compressedBytes: null,
    swapBytes: null,
    nativeHeapBytes: null,
    externalHeapBytes: null,
    openHandles: 1,
    connections: 1,
    unsupportedReasons: {},
  }));
  return {
    capturedAt: new Date(1000 + index * 1000).toISOString(),
    platform,
    processes,
    databases: [],
    aggregate: {
      physicalFootprintBytes: source === "physical_footprint" ? 100 * targets.length : null,
      privateResidentBytes: 100 * targets.length,
      compressedBytes: null,
      swapBytes: null,
      rssBytes: 100 * targets.length,
      virtualSizeBytes: 100 * targets.length,
      nativeHeapBytes: null,
      externalHeapBytes: null,
      openHandles: targets.length,
      connections: targets.length,
      gateMemoryBytes: 100 * targets.length,
      gateMemorySource: source,
      processCount: targets.length,
      metricCoverage: {
        physicalFootprintBytes: source === "physical_footprint" ? targets.length : 0,
        privateResidentBytes: targets.length,
        rssBytes: targets.length,
        openHandles: targets.length,
        connections: targets.length,
      },
      unsupportedReasons: {},
    },
    system: { compressedBytes: null, swapBytes: null, unsupportedReasons: {} },
    cycle: { index, phase: "steady" },
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaged snapshot records required process roles and relevant databases", () => {
  const root = temporaryRoot();
  const database = join(root, "app-server", "butler-client.sqlite");
  mkdirSync(join(root, "app-server"), { recursive: true });
  writeFileSync(database, "database-bytes", "utf8");

  const snapshot = capturePackagedPerformanceSnapshot({
    butlerData: root,
    processTargets,
    capturedAt: new Date("2026-07-27T00:00:00.000Z"),
  });

  expect(snapshot.capturedAt).toBe("2026-07-27T00:00:00.000Z");
  expect(snapshot.processes.map((sample) => sample.role)).toEqual([
    "electron_main",
    "electron_renderer",
    "agent_runtime",
  ]);
  expect(snapshot.processes.every((sample) => sample.rssBytes !== null)).toBe(true);
  expect(snapshot.aggregate.gateMemoryBytes).toBeGreaterThan(0);
  expect(snapshot.aggregate.gateMemorySource).not.toBeNull();
  expect(snapshot.databases).toEqual([{
    relativePath: "app-server/butler-client.sqlite",
    sizeBytes: 14,
  }]);
});

test("packaged report keeps governed gates and emits ungated measurement evidence", () => {
  const root = temporaryRoot();
  const ledgerRoot = join(root, "ledger");
  const databaseRoot = join(root, "app-server");
  mkdirSync(join(ledgerRoot, "work"), { recursive: true });
  mkdirSync(databaseRoot, { recursive: true });
  const work = join(ledgerRoot, "work", "work.md");
  const database = join(databaseRoot, "butler-client.sqlite");
  writeFileSync(work, "before", "utf8");
  writeFileSync(database, "1234", "utf8");
  const ledgerBefore = snapshotLedgerRecords(ledgerRoot);
  const beforeSnapshot = capturePackagedPerformanceSnapshot({
    butlerData: root,
    processTargets,
  });
  writeFileSync(work, "after", "utf8");
  writeFileSync(database, "123456789", "utf8");
  const afterSnapshot = capturePackagedPerformanceSnapshot({
    butlerData: root,
    processTargets,
  });
  const inputPath = join(root, "performance-manifest.json");
  writeFileSync(inputPath, JSON.stringify({
    butlerData: root,
    sinceTs: 100,
    completedAt: 250,
    firstMeaningfulMs: 10,
    toolCalls: [],
    openingDecisions: 1,
    noDeltaBroadReadRounds: 0,
    contractConflicts: 0,
    genericInternalFailures: 0,
    liveReplayParity: true,
    ledgerBefore,
    ledgerRoot,
    toolCompletedAt: [],
    beforeSnapshot,
    processTargets,
    transportCounters: {
      sessionViewRequests: 1,
      liveStreamConnections: 1,
      liveEvents: 4,
      heartbeatEvents: 2,
      reconcileRequests: 0,
    },
  }), "utf8");
  const report = JSON.parse(runPackagedPerformanceReportCli([
    "report",
    "--input",
    inputPath,
  ])) as ElectronForwardProgressBenchmark;

  expect(report.schema).toBe("butler.packaged-performance-measurement.v1");
  expect(report.measurementCompleteness).toEqual({
    complete: true,
    processRoles: {
      electron_main: true,
      electron_renderer: true,
      agent_runtime: true,
    },
    databaseFiles: true,
    transportCounters: true,
  });
  expect(report.databaseGrowth).toMatchObject({
    beforeBytes: 4,
    afterBytes: 9,
    growthBytes: 5,
  });
  expect(report.processMeasurements.map((sample) => sample.role)).toEqual([
    "electron_main",
    "electron_renderer",
    "agent_runtime",
  ]);
  expect(report.processMeasurements.every((sample) => sample.cpuRatio >= 0))
    .toBe(true);
  expect(afterSnapshot.databases[0]?.sizeBytes).toBe(9);
  expect(report.transport.sessionViewRequests).toBe(1);
  expect(report.gate).toMatchObject({ ok: true, failures: [] });
  expect(report.changedLedgerRecords).toEqual(["work/work.md"]);
});

test("packaged measurement CLI exposes an executable snapshot command", () => {
  const root = temporaryRoot();
  const output = runPackagedPerformanceReportCli([
    "snapshot",
    "--butler-data",
    root,
    ...processTargets.flatMap((target) => [
      "--process",
      `${target.role}:${target.pid}`,
    ]),
  ]);
  const snapshot = JSON.parse(output) as { processes: PackagedProcessTarget[] };
  expect(snapshot.processes.map((sample) => sample.role)).toEqual([
    "electron_main",
    "electron_renderer",
    "agent_runtime",
  ]);
});

test("physical memory gate accepts a bounded plateau and embed idle reclamation", () => {
  const memory = [100, 102, 98, 101, 99, 100];
  const snapshots = memory.map((value, index) => ({
    capturedAt: new Date(1000 + index * 1000).toISOString(),
    platform: "darwin" as const,
    processes: [],
    databases: [],
    aggregate: {
      physicalFootprintBytes: value,
      privateResidentBytes: value,
      compressedBytes: null,
      swapBytes: null,
      rssBytes: value,
      virtualSizeBytes: value,
      nativeHeapBytes: null,
      externalHeapBytes: null,
      openHandles: 10,
      connections: 2,
      gateMemoryBytes: value,
      gateMemorySource: "physical_footprint" as const,
      processCount: 1,
      metricCoverage: { physicalFootprintBytes: 1, privateResidentBytes: 1, rssBytes: 1, openHandles: 1, connections: 1 },
      unsupportedReasons: {},
    },
    system: { compressedBytes: null, swapBytes: null, unsupportedReasons: {} },
  }));
  const gate = evaluatePhysicalMemoryGate({
    cycles: snapshots,
    idleReclamation: {
      baselineBytes: 100,
      loadedBytes: 1_000,
      afterIdleBytes: 120,
    },
  });
  expect(gate.ok).toBe(true);
  expect(gate.failures).toEqual([]);
  expect(gate.metrics.finalVsFirstRatio).toBeLessThanOrEqual(1.1);
});

test("physical memory gate rejects monotonic growth and retained embed working set", () => {
  const snapshots = [100, 110, 120, 130, 140, 150].map((value, index) => ({
    capturedAt: new Date(1000 + index * 1000).toISOString(),
    platform: "darwin" as const,
    processes: [],
    databases: [],
    aggregate: {
      physicalFootprintBytes: value,
      privateResidentBytes: value,
      compressedBytes: null,
      swapBytes: null,
      rssBytes: value,
      virtualSizeBytes: value,
      nativeHeapBytes: null,
      externalHeapBytes: null,
      openHandles: 10 + index,
      connections: 2,
      gateMemoryBytes: value,
      gateMemorySource: "physical_footprint" as const,
      processCount: 1,
      metricCoverage: { physicalFootprintBytes: 1, privateResidentBytes: 1, rssBytes: 1, openHandles: 1, connections: 1 },
      unsupportedReasons: {},
    },
    system: { compressedBytes: null, swapBytes: null, unsupportedReasons: {} },
  }));
  const gate = evaluatePhysicalMemoryGate({
    cycles: snapshots,
    idleReclamation: {
      baselineBytes: 100,
      loadedBytes: 1_000,
      afterIdleBytes: 500,
    },
  });
  expect(gate.ok).toBe(false);
  expect(gate.failures.join(" ")).toContain("monotonically");
  expect(gate.failures.join(" ")).toContain("unloaded baseline");
});

test("physical memory gate treats a constant plateau as healthy", () => {
  const cycles = Array.from({ length: 6 }, (_, index) => ({
    capturedAt: new Date(1000 + index * 1000).toISOString(),
    platform: "darwin" as const,
    processes: [],
    databases: [],
    aggregate: {
      physicalFootprintBytes: 100,
      privateResidentBytes: 100,
      compressedBytes: null,
      swapBytes: null,
      rssBytes: 100,
      virtualSizeBytes: 100,
      nativeHeapBytes: null,
      externalHeapBytes: null,
      openHandles: 10,
      connections: 2,
      gateMemoryBytes: 100,
      gateMemorySource: "physical_footprint" as const,
      processCount: 1,
      metricCoverage: { physicalFootprintBytes: 1, openHandles: 1, connections: 1 },
      unsupportedReasons: {},
    },
    system: { compressedBytes: null, swapBytes: null, unsupportedReasons: {} },
  }));
  expect(evaluatePhysicalMemoryGate({
    cycles,
    idleReclamation: { baselineBytes: 100, loadedBytes: 500, afterIdleBytes: 110 },
  }).ok).toBe(true);
});

test("physical memory gate does not hide a missing declared role behind an aggregate fallback", () => {
  const cycles = Array.from({ length: 6 }, (_, index) => ({
    capturedAt: new Date(1000 + index * 1000).toISOString(),
    platform: "darwin" as const,
    processes: [],
    databases: [],
    aggregate: {
      physicalFootprintBytes: 100,
      privateResidentBytes: 100,
      compressedBytes: null,
      swapBytes: null,
      rssBytes: 100,
      virtualSizeBytes: 100,
      nativeHeapBytes: null,
      externalHeapBytes: null,
      openHandles: 10,
      connections: 2,
      gateMemoryBytes: 100,
      gateMemorySource: "physical_footprint" as const,
      processCount: 2,
      metricCoverage: { physicalFootprintBytes: 1, privateResidentBytes: 2, rssBytes: 2, openHandles: 2, connections: 2 },
      unsupportedReasons: { physicalFootprintBytes: "one declared role unavailable" },
    },
    system: { compressedBytes: null, swapBytes: null, unsupportedReasons: {} },
  }));
  const gate = evaluatePhysicalMemoryGate({
    cycles,
    idleReclamation: { baselineBytes: 100, loadedBytes: 500, afterIdleBytes: 110 },
  });
  expect(gate.ok).toBe(false);
  expect(gate.failures.join(" ")).toContain("incomplete");
});

test("Darwin gate does not fall back to private resident when physical footprint is unavailable", () => {
  const cycles = Array.from({ length: 6 }, (_, index) => ({
    capturedAt: new Date(1000 + index * 1000).toISOString(),
    platform: "darwin" as const,
    processes: [],
    databases: [],
    aggregate: {
      physicalFootprintBytes: null,
      privateResidentBytes: 100,
      compressedBytes: null,
      swapBytes: null,
      rssBytes: 100,
      virtualSizeBytes: 100,
      nativeHeapBytes: null,
      externalHeapBytes: null,
      openHandles: 10,
      connections: 2,
      gateMemoryBytes: 100,
      gateMemorySource: "private_resident" as const,
      processCount: 1,
      metricCoverage: { physicalFootprintBytes: 0, privateResidentBytes: 1, openHandles: 1, connections: 1 },
      unsupportedReasons: { physicalFootprintBytes: "footprint unavailable" },
    },
    system: { compressedBytes: null, swapBytes: null, unsupportedReasons: {} },
  }));
  const gate = evaluatePhysicalMemoryGate({
    cycles,
    idleReclamation: { baselineBytes: 100, loadedBytes: 500, afterIdleBytes: 110 },
  });
  expect(gate.ok).toBe(false);
  expect(gate.failures.join(" ")).toContain("unsupported memory samples");
  expect(gate.failures.join(" ")).toContain("incomplete");
});

test("physical gate rejects mixed platform and gate-source cycles", () => {
  const targets = [{ role: "embed" as const, pid: 10, label: "embed-server" }];
  const cycles = Array.from({ length: 6 }, (_, index) => continuityCycle(index, targets));
  cycles[3] = continuityCycle(3, targets, "linux", "private_resident");
  const gate = evaluatePhysicalMemoryGate({
    cycles,
    requiredProcessTargets: targets,
    idleReclamation: { baselineBytes: 100, loadedBytes: 500, afterIdleBytes: 110 },
  });
  expect(gate.ok).toBe(false);
  expect(gate.failures.join(" ")).toContain("mixed platform");
  expect(gate.failures.join(" ")).toContain("mixed gate memory sources");
});

test("physical gate permits supervised embed PID replacement with stable role label", () => {
  const targets = [{ role: "embed" as const, pid: 10, label: "embed-server" }];
  const cycles = Array.from({ length: 6 }, (_, index) => continuityCycle(index, [
    { ...targets[0]!, pid: index === 3 ? 30 : targets[0]!.pid },
  ]));
  const gate = evaluatePhysicalMemoryGate({
    cycles,
    requiredProcessTargets: targets,
    idleReclamation: { baselineBytes: 100, loadedBytes: 500, afterIdleBytes: 110 },
  });
  expect(gate.failures.filter((failure) => failure.includes("PID continuity"))).toEqual([]);
});

test("physical gate rejects non-embed PID replacement", () => {
  const targets = [{ role: "agent_runtime" as const, pid: 10, label: "butler-main" }];
  const cycles = Array.from({ length: 6 }, (_, index) => continuityCycle(index, [
    { ...targets[0]!, pid: index === 3 ? 30 : targets[0]!.pid },
  ]));
  const gate = evaluatePhysicalMemoryGate({
    cycles,
    requiredProcessTargets: targets,
    idleReclamation: { baselineBytes: 100, loadedBytes: 500, afterIdleBytes: 110 },
  });
  expect(gate.ok).toBe(false);
  expect(gate.failures.join(" ")).toContain("PID continuity changed");
});

test("macOS system compressor and swap samples are captured explicitly", () => {
  const snapshot = capturePackagedPerformanceSnapshot({
    butlerData: temporaryRoot(),
    processTargets: [{ role: "embed", pid: 123 }],
    sampler: {
      platform: "darwin",
      run(command) {
        if (command === "ps") return "1.0 100 200 00:00:01";
        if (command === "footprint") return "Footprint: 1000 B";
        if (command === "vmmap") return "Writable regions: Total=1M resident=128K";
        if (command === "lsof") return "COMMAND PID USER FD TYPE NAME";
        if (command === "vm_stat") return "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages occupied by compressor: 3.";
        if (command === "sysctl") return "vm.swapusage: total = 1.00G used = 2.00M free = 1.00G";
        return "";
      },
    },
  });
  expect(snapshot.system.compressedBytes).toBe(3 * 16_384);
  expect(snapshot.system.swapBytes).toBe(2 * 1024 * 1024);
  expect(snapshot.processes[0]?.physicalFootprintBytes).toBe(1_000);
  expect(snapshot.processes[0]?.privateResidentBytes).toBe(128 * 1024);
});

test("snapshot output sentinel is stdout-only and does not create a '-' file", () => {
  const root = temporaryRoot();
  runPackagedPerformanceReportCli([
    "snapshot",
    "--butler-data",
    root,
    ...processTargets.flatMap((target) => ["--process", `${target.role}:${target.pid}`]),
    "--output",
    "-",
  ]);
  expect(existsSync(join(process.cwd(), "-"))).toBe(false);
});

test("extended snapshot CLI enforces all physical roles and preserves labels", () => {
  const root = temporaryRoot();
  const targets: PackagedProcessTarget[] = [
    { role: "electron_main", pid: process.pid },
    { role: "electron_renderer", pid: process.pid, label: "renderer-1" },
    { role: "electron_gpu", pid: process.pid },
    { role: "electron_utility", pid: process.pid, label: "utility-network" },
    { role: "app_gateway", pid: process.pid },
    { role: "agent_runtime", pid: process.pid },
    { role: "embed", pid: process.pid },
    { role: "owned_sidecar", pid: process.pid, label: "sync-consumer" },
  ];
  const output = runPackagedPerformanceReportCli([
    "snapshot",
    "--butler-data",
    root,
    "--require-full-roles",
    ...targets.flatMap((target) => [
      "--process",
      `${target.role}:${target.pid}${target.label ? `:${target.label}` : ""}`,
    ]),
  ]);
  const snapshot = JSON.parse(output) as { processes: Array<{ role: string; label?: string }> };
  expect(snapshot.processes.map((sample) => sample.role)).toEqual(targets.map((target) => target.role));
  expect(snapshot.processes.find((sample) => sample.label === "utility-network")?.role)
    .toBe("electron_utility");
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "butler-packaged-performance-"));
  temporaryRoots.push(root);
  return root;
}
