import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateProjectLedgerPublicationMemoryGate,
  mergeExternalPeak,
  runProjectLedgerPublicationMemoryEvidence,
  type ProjectLedgerPublicationMemoryCycle,
} from "../support/project-ledger-publication-memory/index.ts";
import { waitForClose } from "../support/project-ledger-publication-memory/child-lifecycle.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Project Ledger memory gate passes the independent six-cycle artifact", () => {
  const artifact = [324_322_648, 356_566_384, 332_055_920, 316_147_056, 322_487_664, 326_583_688];
  const cycles = artifact.map((workingSetBytes, index) => cycle({
    index: index + 1,
    phase: "steady",
    source: "working_set",
    workingSetBytes,
    privateCommittedBytes: workingSetBytes - 20,
  }));
  const result = evaluateProjectLedgerPublicationMemoryGate({
    platform: "win32",
    cycles,
  });

  expect(result).toMatchObject({
    status: "pass",
    memorySource: "working_set",
    steadyCycleCount: 6,
    baselineBytes: 332_055_920,
    peakBytes: 356_566_384,
    finalBytes: 322_487_664,
  });
  expect(result.peakToBaselineRatio).toBeCloseTo(322_487_664 / 332_055_920, 8);
});

test("Project Ledger memory gate fails closed for Windows missing counters and over-budget growth", () => {
  const unavailable = evaluateProjectLedgerPublicationMemoryGate({
    platform: "win32",
    cycles: [1, 2, 3, 4, 5, 6].map((index) => cycle({
      index,
      phase: "steady",
      source: "working_set",
      workingSetBytes: null,
      privateCommittedBytes: null,
    })),
  });
  expect(unavailable.status).toBe("unavailable");
  expect(unavailable.status).not.toBe("pass");
  expect(unavailable.failureCodes).toContain("windows_private_committed_unavailable");

  const overBudget = evaluateProjectLedgerPublicationMemoryGate({
    platform: "win32",
    cycles: [700, 800, 820, 810, 805, 800].map((workingSetBytes, index) => cycle({
      index,
      phase: "steady",
      source: "working_set",
      workingSetBytes,
      privateCommittedBytes: workingSetBytes - 1,
    })),
    budgetBytes: 768,
  });
  expect(overBudget.status).toBe("fail");
  expect(overBudget.failureCodes).toContain("memory_budget_exceeded");

  const privateCommittedOverBudget = evaluateProjectLedgerPublicationMemoryGate({
    platform: "win32",
    cycles: [400, 401, 402, 401, 400, 402].map((workingSetBytes, index) => cycle({
      index,
      phase: "steady",
      source: "working_set",
      workingSetBytes,
      privateCommittedBytes: 800,
    })),
    budgetBytes: 768,
  });
  expect(privateCommittedOverBudget.status).toBe("fail");
  expect(privateCommittedOverBudget.failureCodes).toContain("private_committed_budget_exceeded");
  expect(privateCommittedOverBudget.privateCommittedPeakBytes).toBe(800);
});

test("Project Ledger memory gate rejects strictly positive monotonic steady growth", () => {
  const result = evaluateProjectLedgerPublicationMemoryGate({
    platform: "win32",
    cycles: [400, 410, 420, 430, 440, 450].map((workingSetBytes, index) => cycle({
      index,
      phase: "steady",
      source: "working_set",
      workingSetBytes,
      privateCommittedBytes: workingSetBytes,
    })),
  });

  expect(result.status).toBe("fail");
  expect(result.failureCodes).toContain("memory_monotonic_growth");
  expect(result.failureCodes).not.toContain("post_warmup_growth_exceeded");
});

test("Project Ledger memory gate keeps three-cycle evidence unavailable", () => {
  const result = evaluateProjectLedgerPublicationMemoryGate({
    platform: "linux",
    cycles: [100, 101, 100].map((privateResidentBytes, index) => cycle({
      index,
      phase: "steady",
      source: "private_resident",
      privateResidentBytes,
    })),
    requiredSteadyCycles: 3,
  });

  expect(result.status).toBe("unavailable");
  expect(result.failureCodes).toEqual(["steady_cycles_incomplete"]);
});

test("Project Ledger memory gate keeps macOS and Linux source contracts distinct", () => {
  const darwin = evaluateProjectLedgerPublicationMemoryGate({
    platform: "darwin",
    cycles: [100, 101, 102, 101, 100, 101].map((physicalFootprintBytes, index) => cycle({
      index,
      phase: "steady",
      source: "physical_footprint",
      physicalFootprintBytes,
    })),
    budgetBytes: 768,
  });
  const linux = evaluateProjectLedgerPublicationMemoryGate({
    platform: "linux",
    cycles: [100, 101, 102, 101, 100, 101].map((privateResidentBytes, index) => cycle({
      index,
      phase: "steady",
      source: "private_resident",
      privateResidentBytes,
    })),
    budgetBytes: 768,
  });
  expect(darwin).toMatchObject({ status: "pass", memorySource: "physical_footprint" });
  expect(linux).toMatchObject({ status: "pass", memorySource: "private_resident" });
});

test("peak evidence rejects a transient in-cycle spike even when the after-only sample is low", () => {
  const afterOnly = cycle({
    index: 2,
    phase: "steady",
    source: "working_set",
    workingSetBytes: 400,
    privateCommittedBytes: 400,
  });
  const inCyclePeak = cycle({
    index: 2,
    phase: "steady",
    source: "working_set",
    workingSetBytes: 900,
    privateCommittedBytes: 900,
  });
  const mergedExternal = mergeExternalPeak(afterOnly.external, inCyclePeak.external);
  const cycles = [
    cycle({
      index: 1,
      phase: "steady",
      source: "working_set",
      workingSetBytes: 390,
      privateCommittedBytes: 390,
    }),
    {
      ...afterOnly,
      external: mergedExternal,
    },
    cycle({
      index: 3,
      phase: "steady",
      source: "working_set",
      workingSetBytes: 420,
      privateCommittedBytes: 420,
    }),
    cycle({
      index: 4,
      phase: "steady",
      source: "working_set",
      workingSetBytes: 410,
      privateCommittedBytes: 410,
    }),
    cycle({
      index: 5,
      phase: "steady",
      source: "working_set",
      workingSetBytes: 400,
      privateCommittedBytes: 400,
    }),
    cycle({
      index: 6,
      phase: "steady",
      source: "working_set",
      workingSetBytes: 420,
      privateCommittedBytes: 420,
    }),
  ];
  const result = evaluateProjectLedgerPublicationMemoryGate({
    platform: "win32",
    cycles,
    budgetBytes: 768,
  });
  expect(result.status).toBe("fail");
  expect(result.failureCodes).toContain("memory_budget_exceeded");
  expect(result.peakBytes).toBe(900);
  expect(result.privateCommittedPeakBytes).toBe(900);
});

test("parent observation orchestration uses the pure in-cycle peak merge", () => {
  const cli = readFileSync(
    new URL("../support/project-ledger-publication-memory-cli.ts", import.meta.url),
    "utf8",
  );
  expect(cli).toContain("mergeExternalPeak");
  expect(cli).toContain("setInterval(readSample, 250)");
  expect(cli).toContain("const childExitPromise = waitForClose");
  expect(cli).toContain("const linesClosedPromise = lines");
  expect(cli).toContain("clearInterval(timer);");
});

test("child lifecycle waits resolve when readline closes before the child", async () => {
  const child = new EventEmitter();
  const lines = new EventEmitter();
  const childExitPromise = waitForClose((onClose) => child.once("close", onClose));
  const linesClosedPromise = waitForClose((onClose) => lines.once("close", onClose));
  let resolved = false;
  const bothClosed = Promise.all([childExitPromise, linesClosedPromise]).then(() => {
    resolved = true;
  });

  lines.emit("close");
  await Promise.resolve();
  expect(resolved).toBe(false);
  child.emit("close");
  await bothClosed;
  expect(resolved).toBe(true);
});

test("publication memory runner performs one warmup plus six steady mutations in one process", async () => {
  const root = mkdtempSync(join(tmpdir(), "project-ledger-publication-memory-runner-"));
  roots.push(root);
  mkdirSync(join(root, "work"), { recursive: true });
  writeFileSync(join(root, "project.json"), `${JSON.stringify({
    schema: "project-ledger.project.v1",
    id: "fixture",
    name: "Fixture",
  })}\n`);
  writeFileSync(join(root, "ledger.jsonl"), "{}\n");
  writeFileSync(join(root, "work", "W-MEMORY.md"), "---\nid: W-MEMORY\nkind: work\nstatus: in_progress\n---\n\nFixture\n");
  const samples = [100, 102, 104, 102, 103, 101, 102];
  const calls: Array<{ projectRoot: string; effectKey: string }> = [];
  let sampleIndex = 0;
  let clock = 0;
  let closed = false;
  const evidence = await runProjectLedgerPublicationMemoryEvidence({
    ledgerRoot: root,
    butlerData: join(root, "runtime"),
    recordId: "W-MEMORY",
    recordKind: "work",
    platform: "linux",
    minimumCorpus: { recordCount: 1, totalBytes: 1 },
  }, {
    applyPublication: async (input) => {
      calls.push({ projectRoot: input.projectRoot, effectKey: input.effectKey });
      return {} as never;
    },
    createSampler: () => ({
      sample: () => ({
        source: "private_resident",
        rssBytes: samples[sampleIndex],
        physicalFootprintBytes: null,
        privateResidentBytes: samples[sampleIndex++]!,
        workingSetBytes: null,
        privateCommittedBytes: null,
      }),
      close: () => { closed = true; },
    }),
    memoryUsage: () => ({
      rss: 10,
      heapTotal: 20,
      heapUsed: 5,
      external: 2,
      arrayBuffers: 1,
    }),
    monotonicMs: () => {
      clock += 10;
      return clock;
    },
  });

  expect(calls).toHaveLength(7);
  expect(new Set(calls.map((call) => call.projectRoot))).toEqual(new Set([root]));
  expect(new Set(calls.map((call) => call.effectKey)).size).toBe(7);
  expect(evidence.cycles.map((cycle) => cycle.phase)).toEqual([
    "warmup", "steady", "steady", "steady", "steady", "steady", "steady",
  ]);
  expect(evidence.cycles.every((cycle) => cycle.completed)).toBe(true);
  expect(evidence.gate).toMatchObject({
    status: "pass",
    memorySource: "private_resident",
    steadyCycleCount: 6,
  });
  expect(JSON.stringify(evidence)).not.toContain(root);
  expect(JSON.stringify(evidence)).not.toContain("W-MEMORY");
  expect(closed).toBe(true);
});

test("publication memory runner does not claim large-corpus evidence for a small clone", async () => {
  const root = mkdtempSync(join(tmpdir(), "project-ledger-publication-memory-small-"));
  roots.push(root);
  writeFileSync(join(root, "project.json"), "{}\n");
  writeFileSync(join(root, "ledger.jsonl"), "{}\n");

  const evidence = await runProjectLedgerPublicationMemoryEvidence({
    ledgerRoot: root,
    butlerData: join(root, "runtime"),
    recordId: "not-used",
    platform: "darwin",
  }, {
    applyPublication: async () => { throw new Error("must not run"); },
  });
  expect(evidence.gate).toMatchObject({
    status: "unavailable",
    failureCodes: ["ledger_clone_below_required_size"],
  });
  expect(evidence.gate.status).not.toBe("pass");
});

function cycle(input: {
  index: number;
  phase: "warmup" | "steady";
  source: "physical_footprint" | "private_resident" | "working_set";
  physicalFootprintBytes?: number | null;
  privateResidentBytes?: number | null;
  workingSetBytes?: number | null;
  privateCommittedBytes?: number | null;
}): ProjectLedgerPublicationMemoryCycle {
  return {
    index: input.index,
    phase: input.phase,
    durationMs: 10,
    completed: true,
    internal: {
      rssBytes: 1,
      heapUsedBytes: 1,
      externalBytes: 1,
      arrayBufferBytes: 1,
    },
    external: {
      source: input.source,
      rssBytes: null,
      physicalFootprintBytes: input.physicalFootprintBytes ?? null,
      privateResidentBytes: input.privateResidentBytes ?? null,
      workingSetBytes: input.workingSetBytes ?? null,
      privateCommittedBytes: input.privateCommittedBytes ?? null,
    },
  };
}
