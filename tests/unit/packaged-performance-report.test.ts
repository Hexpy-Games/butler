import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturePackagedPerformanceSnapshot,
  type PackagedProcessTarget,
} from "../support/packaged-performance-snapshot.ts";
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

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "butler-packaged-performance-"));
  temporaryRoots.push(root);
  return root;
}
