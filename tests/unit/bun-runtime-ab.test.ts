import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANDIDATE_BUN_VERSION,
  compareBunRuntimeAb,
  MIN_PHYSICAL_IMPROVEMENT_RATIO,
  PINNED_BUN_VERSION,
  type BunRuntimeAbManifest,
  type BunRuntimeEvidence,
} from "../support/bun-runtime-ab.ts";
import { runElectronParentArchiveGuard } from "../support/bun-runtime-ab-archive-guard.ts";
import { runBunRuntimeAbCli } from "../support/bun-runtime-ab-cli.ts";
import type { PhysicalMemoryGateResult } from "../support/physical-memory-gate.ts";
import type { PackagedProcessTarget } from "../support/packaged-performance-snapshot.ts";

const processTargets: PackagedProcessTarget[] = [
  { role: "electron_main", pid: 101, label: "main" },
  { role: "electron_renderer", pid: 102, label: "renderer" },
  { role: "agent_runtime", pid: 103 },
];

test("Bun A/B comparator recommends the candidate only with matched evidence and no safety regression", () => {
  const report = compareBunRuntimeAb(manifest({
    pinnedMemoryRatio: 1.08,
    candidateMemoryRatio: 1.02,
    pinnedResourceValues: [10, 11, 10, 10, 11, 10],
    candidateResourceValues: [10, 10, 10, 10, 10, 10],
  }));

  expect(report.decision).toBe("candidate");
  expect(report.recommendation).toBe("adopt-candidate");
  expect(report.comparable).toBe(true);
  expect(report.variants.candidate.eligible).toBe(true);
  expect(report.reasons.join(" ")).toContain("improves");
});

test("Bun A/B comparator keeps the pin when cache identity or archive guard is not comparable", () => {
  const input = manifest({
    pinnedMemoryRatio: 1.08,
    candidateMemoryRatio: 1.01,
    pinnedResourceValues: [10, 10, 10, 10, 10, 10],
    candidateResourceValues: [10, 10, 10, 10, 10, 10],
  });
  input.candidate.cacheFingerprint = "different-cache";
  input.candidate.archiveStream = { ok: false, detail: "compressed EOF timeout" };

  const report = compareBunRuntimeAb(input);

  expect(report.decision).toBe("no-change");
  expect(report.recommendation).toBe("keep-pinned");
  expect(report.comparable).toBe(false);
  expect(report.variants.candidate.eligible).toBe(false);
  expect(report.reasons.join(" ")).toContain("cache fingerprints");
  expect(report.reasons.join(" ")).toContain("archive stream check failed");
});

test("Bun A/B comparator may use a pinned archive diagnostic as baseline while requiring a healthy candidate", () => {
  const input = manifest({
    pinnedMemoryRatio: 1.12,
    candidateMemoryRatio: 1.02,
    pinnedResourceValues: [10, 10, 10, 10, 10, 10],
    candidateResourceValues: [10, 10, 10, 10, 10, 10],
  });
  input.pinned.archiveStream = {
    ...input.pinned.archiveStream,
    ok: false,
    successes: 9,
    detail: "historical Electron-parent diagnostic",
  };
  const diagnosticReport = compareBunRuntimeAb(input);
  expect(diagnosticReport.variants.pinned.baselineEligible).toBe(true);
  expect(diagnosticReport.variants.pinned.eligible).toBe(false);
  expect(diagnosticReport.variants.candidate.eligible).toBe(true);
  expect(diagnosticReport.decision).toBe("candidate");
});

test("Bun A/B comparator treats PIDs as run-local while requiring role and label attribution", () => {
  const input = manifest({
    pinnedMemoryRatio: 1.08,
    candidateMemoryRatio: 1.02,
    pinnedResourceValues: [10, 10, 10, 10, 10, 10],
    candidateResourceValues: [10, 10, 10, 10, 10, 10],
  });
  input.candidate.processTargets = processTargets.map((target) => ({
    ...target,
    pid: target.pid + 1000,
  }));
  expect(compareBunRuntimeAb(input).comparability.processAttributionMatch).toBe(true);

  input.candidate.processTargets = input.candidate.processTargets.map((target) =>
    target.role === "agent_runtime" ? { ...target, label: "different" } : target,
  );
  expect(compareBunRuntimeAb(input).decision).toBe("no-change");
  expect(compareBunRuntimeAb(input).comparability.processAttributionMatch).toBe(false);
});

test("Bun A/B comparator rejects a memory delta inside the conservative noise margin", () => {
  const pinnedMemoryRatio = 1.08;
  const input = manifest({
    pinnedMemoryRatio,
    candidateMemoryRatio: pinnedMemoryRatio * (1 - MIN_PHYSICAL_IMPROVEMENT_RATIO / 2),
    pinnedResourceValues: [10, 10, 10, 10, 10, 10],
    candidateResourceValues: [10, 10, 10, 10, 10, 10],
  });
  const report = compareBunRuntimeAb(input);
  expect(report.decision).toBe("no-change");
  expect(report.reasons.join(" ")).toContain("does not improve");
});

test("Electron-parent archive guard records ten successful execution attempts", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-archive-guard-"));
  try {
    const fixture = join(root, "parent-fixture.js");
    writeFileSync(
      fixture,
      'console.log(JSON.stringify({schema:"butler.archive-stream-guard.v1",ok:true,hasLauncher:true}));\n',
      "utf8",
    );
    const result = runElectronParentArchiveGuard({
      parentExecutable: process.execPath,
      parentArgs: [fixture],
      bunExecutable: process.execPath,
      attempts: 10,
    });
    expect(result).toMatchObject({ ok: true, attempts: 10, successes: 10 });
    expect(result.command).toEqual([process.execPath, fixture]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bun A/B CLI writes a structured no-change report for ambiguous evidence", () => {
  const input = manifest({
    pinnedMemoryRatio: 1.02,
    candidateMemoryRatio: 1.02,
    pinnedResourceValues: [10, 10, 10, 10, 10, 10],
    candidateResourceValues: [10, 10, 10, 10, 10, 10],
  });
  const root = mkdtempSync(join(tmpdir(), "butler-bun-ab-"));
  try {
    const inputPath = join(root, "manifest.json");
    const outputPath = join(root, "report.json");
    writeFileSync(inputPath, JSON.stringify(input), "utf8");
    const report = JSON.parse(runBunRuntimeAbCli([
      "compare",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ]));
    expect(report.decision).toBe("no-change");
    expect(JSON.parse(readFileSync(outputPath, "utf8")).schema)
      .toBe("butler.bun-runtime-ab.v1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function manifest(options: {
  pinnedMemoryRatio: number;
  candidateMemoryRatio: number;
  pinnedResourceValues: Array<number | null>;
  candidateResourceValues: Array<number | null>;
}): BunRuntimeAbManifest {
  const sourceFingerprint = "source-sha";
  const dataFingerprint = "data-sha";
  const cacheFingerprint = "cache-sha";
  return {
    schema: "butler.bun-runtime-ab.v1",
    sourceFingerprint,
    dataFingerprint,
    warmupCycles: 2,
    steadyCycles: 6,
    pinned: evidence({
      variant: "pinned",
      version: PINNED_BUN_VERSION,
      sourceFingerprint,
      dataFingerprint,
      cacheFingerprint,
      memoryRatio: options.pinnedMemoryRatio,
      resourceValues: options.pinnedResourceValues,
    }),
    candidate: evidence({
      variant: "candidate",
      version: CANDIDATE_BUN_VERSION,
      sourceFingerprint,
      dataFingerprint,
      cacheFingerprint,
      memoryRatio: options.candidateMemoryRatio,
      resourceValues: options.candidateResourceValues,
    }),
  };
}

function evidence(options: {
  variant: "pinned" | "candidate";
  version: string;
  sourceFingerprint: string;
  dataFingerprint: string;
  cacheFingerprint: string;
  memoryRatio: number;
  resourceValues: Array<number | null>;
}): BunRuntimeEvidence {
  return {
    variant: options.variant,
    executable: "bun",
    executableFingerprint: `bun-${options.version}-fingerprint`,
    version: options.version,
    sourceFingerprint: options.sourceFingerprint,
    dataFingerprint: options.dataFingerprint,
    warmupCycles: 2,
    steadyCycles: 6,
    processTargets,
    cacheFingerprint: options.cacheFingerprint,
    cachePolicy: "fresh-isolated-runtime-model-cache-v1",
    cacheResourceDigest: "resource-cache-sha",
    modelCacheDigest: "model-cache-sha",
    physicalGate: gate(options.memoryRatio, options.resourceValues),
    correctness: { ok: true },
    archiveStream: {
      ok: true,
      schema: "butler.archive-stream-guard.v1",
      commandLabel: "electron+1args",
      commandFingerprint: "archive-command-fingerprint",
      attempts: 10,
      successes: 10,
      executable: "bun",
      executableFingerprint: "bun-executable-fingerprint",
      version: options.version,
    },
    packaging: {
      ok: true,
      schema: "butler.bun-packaging-guard.v1",
      commandLabel: "bun+2args",
      commandFingerprint: "packaging-command-fingerprint",
      attempts: 23,
      successes: 23,
      executable: "bun",
      executableFingerprint: "bun-executable-fingerprint",
      version: options.version,
    },
  };
}

function gate(memoryRatio: number, resourceValues: Array<number | null>): PhysicalMemoryGateResult {
  return {
    ok: true,
    failures: [],
    metrics: {
      steadyCycleCount: 6,
      firstThreeMedianBytes: 100,
      finalThreeMedianBytes: 100 * memoryRatio,
      finalVsFirstRatio: memoryRatio,
      memoryValues: [100, 100, 100, 100 * memoryRatio, 100 * memoryRatio, 100 * memoryRatio],
      resourceValues,
      memorySource: "physical_footprint",
      embedBaselineBytes: 100,
      embedLoadedBytes: 500,
      embedAfterIdleBytes: 110,
    },
    unsupportedReasons: [],
  };
}
