#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateProjectLedgerPublicationMemoryGate,
  mergeExternalPeak,
  readLatestExternalSample,
  runProjectLedgerPublicationMemoryEvidence,
  type ProjectLedgerPublicationMemoryEvidence,
  type ProjectLedgerPublicationMemoryExternalSample,
  type ProjectLedgerPublicationMemoryRunnerInput,
} from "./project-ledger-publication-memory/index.ts";
import { createRuntimeMemoryPhysicalObserver } from
  "../../packages/butler-agent/src/operations/diagnostics/runtime-memory-physical-observer.ts";
import { waitForClose } from "./project-ledger-publication-memory/child-lifecycle.ts";

const args = process.argv.slice(2);
if (args.includes("--worker")) {
  await runWorker(args.filter((arg) => arg !== "--worker"));
} else {
  const options = parseArgs(args);
  if (!options) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
  } else {
    const evidence = await runObservedChild(options.input);
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    if (options.output) {
      writeFileSync(options.output, serialized, { encoding: "utf8", mode: 0o600 });
      chmodSync(options.output, 0o600);
    } else process.stdout.write(serialized);
    process.exitCode = evidence.gate.status === "pass"
      ? 0
      : evidence.gate.status === "unavailable" ? 3 : 1;
  }
}

async function runWorker(args: string[]): Promise<void> {
  const options = parseArgs(args);
  if (!options) {
    writeWorkerMessage({ type: "result", evidence: unavailableEvidence("worker_arguments_unavailable") });
    process.exitCode = 3;
    return;
  }
  const evidence = await runProjectLedgerPublicationMemoryEvidence(options.input, {
    createSampler: () => ({
      sample: () => ({
        source: null,
        rssBytes: null,
        physicalFootprintBytes: null,
        privateResidentBytes: null,
        workingSetBytes: null,
        privateCommittedBytes: null,
      }),
      close() {},
    }),
    onCycleStart: (cycle) => writeWorkerMessage({ type: "phase_start", ...cycle }),
    onCycleEnd: (cycle) => writeWorkerMessage({ type: "phase_end", ...cycle }),
  });
  writeWorkerMessage({ type: "result", evidence });
  process.exitCode = evidence.gate.status === "fail" ? 1 : 0;
}

function writeWorkerMessage(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function runObservedChild(input: ProjectLedgerPublicationMemoryRunnerInput): Promise<ProjectLedgerPublicationMemoryEvidence> {
  const observerDirectory = mkdtempSync(join(tmpdir(), "project-ledger-memory-parent-observer-"));
  const observerPath = join(observerDirectory, "physical.jsonl");
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url),
    "--worker",
    "--ledger-root", input.ledgerRoot,
    "--butler-data", input.butlerData,
    "--record-id", input.recordId,
    ...(input.recordKind ? ["--record-kind", input.recordKind] : []),
    ...(input.steadyCycles ? ["--steady-cycles", String(input.steadyCycles)] : []),
  ], { stdio: ["ignore", "pipe", "ignore"] });
  const observer = child.pid
    ? createRuntimeMemoryPhysicalObserver({
      pid: child.pid,
      outputPath: observerPath,
    })
    : null;
  const peaks = new Map<number, ProjectLedgerPublicationMemoryExternalSample>();
  let activeCycle: number | null = null;
  const resultHolder: { evidence: ProjectLedgerPublicationMemoryEvidence | null } = { evidence: null };
  const readSample = (): void => {
    if (!observer || activeCycle === null) return;
    try {
      observer.sample("other");
      const sample = readLatestExternalSample(observerPath, process.platform);
      peaks.set(activeCycle, mergeExternalPeak(peaks.get(activeCycle) ?? null, sample));
    } catch {
      // A missing external sample remains unavailable and cannot become PASS.
    }
  };
  const lines = child.stdout ? createInterface({ input: child.stdout }) : null;
  const childExitPromise = waitForClose((onClose) => {
    child.once("close", onClose);
  });
  const linesClosedPromise = lines
    ? waitForClose((onClose) => lines.once("close", onClose))
    : Promise.resolve();
  lines?.on("line", (line) => {
    const marker = parseWorkerMessage(line);
    if (!marker) return;
    if (marker.type === "phase_start") {
      activeCycle = marker.index;
      readSample();
    } else if (marker.type === "phase_end") {
      readSample();
      activeCycle = null;
    } else if (marker.type === "result") {
      resultHolder.evidence = marker.evidence;
    }
  });
  readSample();
  const timer = setInterval(readSample, 250);
  try {
    await Promise.all([childExitPromise, linesClosedPromise]);
    readSample();
    const childEvidence = resultHolder.evidence;
    if (!childEvidence) return unavailableEvidence("worker_result_unavailable");
    if (childEvidence.cycles.length === 0) return childEvidence;
    const cycles = childEvidence.cycles.map((cycle) => ({
      ...cycle,
      external: peaks.get(cycle.index) ?? cycle.external,
    }));
    const gate = evaluateProjectLedgerPublicationMemoryGate({
      platform: childEvidence.platform,
      cycles,
      requiredSteadyCycles: input.steadyCycles,
      runFailureCodes: childEvidence.gate.failureCodes.includes("publication_failed")
        ? ["publication_failed"] : [],
    });
    return { ...childEvidence, cycles, gate };
  } finally {
    clearInterval(timer);
    try {
      observer?.close();
    } catch {
      // External observer cleanup is best effort and cannot change evidence.
    }
    rmSync(observerDirectory, { recursive: true, force: true });
  }
}

function parseWorkerMessage(line: string):
  | { type: "phase_start"; index: number; phase: "warmup" | "steady" }
  | { type: "phase_end"; index: number; phase: "warmup" | "steady"; durationMs: number; completed: boolean }
  | { type: "result"; evidence: ProjectLedgerPublicationMemoryEvidence }
  | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.type === "phase_start" && Number.isSafeInteger(value.index) &&
      (value.phase === "warmup" || value.phase === "steady")) {
      return {
        type: "phase_start",
        index: Number(value.index),
        phase: value.phase as "warmup" | "steady",
      };
    }
    if (value.type === "phase_end" && Number.isSafeInteger(value.index) &&
      (value.phase === "warmup" || value.phase === "steady") &&
      typeof value.durationMs === "number" && typeof value.completed === "boolean") {
      return {
        type: "phase_end",
        index: Number(value.index),
        phase: value.phase as "warmup" | "steady",
        durationMs: Number(value.durationMs),
        completed: value.completed,
      };
    }
    if (value.type === "result" && value.evidence && typeof value.evidence === "object") {
      return { type: "result", evidence: value.evidence as ProjectLedgerPublicationMemoryEvidence };
    }
  } catch {
    // Child diagnostics are best effort and are never surfaced verbatim.
  }
  return null;
}

function unavailableEvidence(code: string): ProjectLedgerPublicationMemoryEvidence {
  return {
    schema: "butler.project-ledger-publication-memory.v1",
    platform: process.platform,
    corpus: {
      recordCount: 0,
      totalBytes: 0,
      requiredRecords: 3_000,
      requiredBytes: 100 * 1024 * 1024,
    },
    cycles: [],
    gate: {
      status: "unavailable",
      budgetBytes: 768 * 1024 * 1024,
      memorySource: null,
      steadyCycleCount: 0,
      baselineBytes: null,
      peakBytes: null,
      finalBytes: null,
      peakToBaselineRatio: null,
      privateCommittedPeakBytes: null,
      failureCodes: [code],
    },
    privacy: {
      rawPathsIncluded: false,
      rawRecordContentsIncluded: false,
      processIdentityIncluded: false,
    },
  };
}

function parseArgs(args: string[]): {
  input: {
    ledgerRoot: string;
    butlerData: string;
    recordId: string;
    recordKind?: string;
    steadyCycles?: number;
  };
  output?: string;
} | null {
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1]?.trim() : undefined;
  };
  const ledgerRoot = value("--ledger-root");
  const butlerData = value("--butler-data");
  const recordId = value("--record-id");
  const recordKind = value("--record-kind");
  const steadyCycles = value("--steady-cycles");
  const output = value("--output");
  if (!ledgerRoot || !butlerData || !recordId) return null;
  return {
    input: {
      ledgerRoot,
      butlerData,
      recordId,
      ...(recordKind ? { recordKind } : {}),
      ...(steadyCycles ? { steadyCycles: Number(steadyCycles) } : {}),
    },
    ...(output ? { output } : {}),
  };
}

function usage(): string {
  return [
    "Project Ledger publication memory evidence runner",
    "",
    "Usage:",
    "  bun tests/support/project-ledger-publication-memory-cli.ts \\",
    "    --ledger-root <cloned-ledger-root> \\",
    "    --butler-data <private-runtime-data-root> \\",
    "    --record-id <existing-record-id> \\",
    "    [--record-kind <work|task|attempt|reference|...>] \\",
    "    [--steady-cycles <6..12>] \\",
    "    [--output <privacy-safe-report.json>]",
    "",
    "The runner executes one warmup and six steady mutations in one process.",
    "Exit 0 means the platform-specific gate passed; 1 means failed; 3 means unavailable.",
  ].join("\n");
}
