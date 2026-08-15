import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyProjectLedgerRecordUpdates,
} from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/external-effect-mutation.ts";
import {
  createRuntimeMemoryPhysicalObserver,
  type RuntimeMemoryPhysicalObserverCounters,
  type RuntimeMemoryPhysicalObserverRecord,
} from "../../packages/butler-agent/src/operations/diagnostics/runtime-memory-physical-observer.ts";
import type { ProjectLedgerRecordUpdate } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/external-effect-record-update.ts";
import {
  PROJECT_LEDGER_MEMORY_BUDGET_BYTES,
  PROJECT_LEDGER_REQUIRED_BYTES,
  PROJECT_LEDGER_REQUIRED_RECORDS,
  PROJECT_LEDGER_PUBLICATION_MEMORY_SCHEMA,
  type CyclePhase,
  type ProjectLedgerExternalMemorySampler,
  type ProjectLedgerPublicationMemoryCycle,
  type ProjectLedgerPublicationMemoryEvidence,
  type ProjectLedgerPublicationMemoryExternalSample,
  type ProjectLedgerPublicationMemoryGate,
  type ProjectLedgerPublicationMemoryRunnerDependencies,
  type ProjectLedgerPublicationMemoryRunnerInput,
} from "./project-ledger-publication-memory/contracts.ts";
import {
  boundedSteadyCycles,
  evaluateProjectLedgerPublicationMemoryGate,
  memorySourceForPlatform,
} from "./project-ledger-publication-memory/gate.ts";
export async function runProjectLedgerPublicationMemoryEvidence(
  input: ProjectLedgerPublicationMemoryRunnerInput,
  dependencies: ProjectLedgerPublicationMemoryRunnerDependencies = {},
): Promise<ProjectLedgerPublicationMemoryEvidence> {
  const platform = input.platform ?? process.platform;
  const minimumCorpus = {
    recordCount: input.minimumCorpus?.recordCount ?? PROJECT_LEDGER_REQUIRED_RECORDS,
    totalBytes: input.minimumCorpus?.totalBytes ?? PROJECT_LEDGER_REQUIRED_BYTES,
  };
  const corpus = summarizeLedger(input.ledgerRoot);
  const emptyCycles: ProjectLedgerPublicationMemoryCycle[] = [];
  if (!corpus) {
    return evidenceWithGate(platform, {
      recordCount: 0,
      totalBytes: 0,
      requiredRecords: minimumCorpus.recordCount,
      requiredBytes: minimumCorpus.totalBytes,
    }, emptyCycles, {
      status: "unavailable",
      budgetBytes: PROJECT_LEDGER_MEMORY_BUDGET_BYTES,
      memorySource: memorySourceForPlatform(platform),
      steadyCycleCount: 0,
      baselineBytes: null,
      peakBytes: null,
      finalBytes: null,
      peakToBaselineRatio: null,
      privateCommittedPeakBytes: null,
      failureCodes: ["ledger_clone_unavailable"],
    });
  }

  const corpusSummary = {
    ...corpus,
    requiredRecords: minimumCorpus.recordCount,
    requiredBytes: minimumCorpus.totalBytes,
  };
  if (corpus.recordCount < minimumCorpus.recordCount || corpus.totalBytes < minimumCorpus.totalBytes) {
    return evidenceWithGate(platform, corpusSummary, emptyCycles, {
      status: "unavailable",
      budgetBytes: PROJECT_LEDGER_MEMORY_BUDGET_BYTES,
      memorySource: memorySourceForPlatform(platform),
      steadyCycleCount: 0,
      baselineBytes: null,
      peakBytes: null,
      finalBytes: null,
      peakToBaselineRatio: null,
      privateCommittedPeakBytes: null,
      failureCodes: ["ledger_clone_below_required_size"],
    });
  }

  let sampler: ProjectLedgerExternalMemorySampler | null = null;
  try {
    sampler = dependencies.createSampler?.(platform) ?? createDefaultSampler(platform);
  } catch {
  }
  const applyPublication = dependencies.applyPublication ?? applyProjectLedgerRecordUpdates;
  const memoryUsage = dependencies.memoryUsage ?? (() => process.memoryUsage());
  const monotonicMs = dependencies.monotonicMs ?? (() => performance.now());
  const runToken = randomUUID();
  const steadyCycles = boundedSteadyCycles(input.steadyCycles);
  const cycles: ProjectLedgerPublicationMemoryCycle[] = [];
  const runFailureCodes: string[] = [];

  try {
    for (let index = 0; index < steadyCycles + 1; index += 1) {
      const phase: CyclePhase = index === 0 ? "warmup" : "steady";
      const startedAt = safeMonotonicMs(monotonicMs);
      const before = readInternalMemory(memoryUsage);
      let completed = false;
      await safeCycleMarker(dependencies.onCycleStart, { index, phase });
      try {
        await applyPublication({
          butlerData: input.butlerData,
          projectRoot: input.ledgerRoot,
          effectKey: `project-ledger-memory-gate:${runToken}:${index}`,
          updates: [memoryGateUpdate(input, index)],
        });
        completed = true;
      } catch {
        runFailureCodes.push("publication_failed");
      }
      const durationMs = Math.max(0, safeMonotonicMs(monotonicMs) - startedAt);
      await safeCycleMarker(dependencies.onCycleEnd, { index, phase, durationMs, completed });
      const after = readInternalMemory(memoryUsage);
      const external = sampler
        ? safeExternalSample(sampler, platform)
        : unavailableExternalSample(platform);
      cycles.push({
        index,
        phase,
        durationMs,
        completed,
        internal: after ?? before,
        external,
      });
      if (!completed) break;
    }
  } finally {
    try {
      sampler?.close();
    } catch {
      // Evidence cleanup is best effort and never changes the publication result.
    }
  }

  const gate = evaluateProjectLedgerPublicationMemoryGate({
    platform,
    cycles,
    runFailureCodes,
    requiredSteadyCycles: steadyCycles,
  });
  return evidenceWithGate(platform, corpusSummary, cycles, gate);
}

function memoryGateUpdate(
  input: ProjectLedgerPublicationMemoryRunnerInput,
  index: number,
): ProjectLedgerRecordUpdate {
  return {
    id: input.recordId,
    ...(input.recordKind ? { kind: input.recordKind } : {}),
    reason: `Project Ledger memory gate cycle ${index}`,
  };
}

function summarizeLedger(root: string): { recordCount: number; totalBytes: number } | null {
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return null;
    let recordCount = 0;
    let totalBytes = 0;
    const visit = (directory: string, isRoot = false): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "index" || entry.name === "views") continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(path);
          continue;
        }
        if (!entry.isFile()) continue;
        const size = statSync(path).size;
        totalBytes += Number.isSafeInteger(size) ? size : 0;
        if (!isRoot || entry.name !== "project.json") {
          if (entry.name !== "ledger.jsonl" && /\.(?:json|md)$/u.test(entry.name)) recordCount += 1;
        }
      }
    };
    visit(root, true);
    return { recordCount, totalBytes };
  } catch {
    return null;
  }
}

function createDefaultSampler(platform: NodeJS.Platform): ProjectLedgerExternalMemorySampler {
  const directory = mkdtempSync(join(tmpdir(), "project-ledger-memory-observer-"));
  const outputPath = join(directory, "physical.jsonl");
  const observer = createRuntimeMemoryPhysicalObserver({
    pid: process.pid,
    outputPath,
    platform,
  });
  return {
    sample() {
      observer.sample("other");
      return readLatestExternalSample(outputPath, platform);
    },
    close() {
      observer.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function readLatestExternalSample(
  outputPath: string,
  platform: NodeJS.Platform,
): ProjectLedgerPublicationMemoryExternalSample {
  try {
    const lines = readFileSync(outputPath, "utf8").trim().split("\n");
    const record = JSON.parse(lines.at(-1) ?? "") as RuntimeMemoryPhysicalObserverRecord;
    return externalSampleFromCounters(platform, record.counters);
  } catch {
    return unavailableExternalSample(platform);
  }
}

function externalSampleFromCounters(
  platform: NodeJS.Platform,
  counters: RuntimeMemoryPhysicalObserverCounters,
): ProjectLedgerPublicationMemoryExternalSample {
  return {
    source: memorySourceForPlatform(platform),
    rssBytes: safeNullableBytes(counters.rssBytes),
    physicalFootprintBytes: safeNullableBytes(counters.physicalFootprintBytes),
    privateResidentBytes: safeNullableBytes(counters.privateResidentBytes),
    workingSetBytes: safeNullableBytes(counters.workingSetBytes),
    privateCommittedBytes: safeNullableBytes(counters.privateCommittedBytes),
  };
}

function safeExternalSample(
  sampler: ProjectLedgerExternalMemorySampler,
  platform: NodeJS.Platform,
): ProjectLedgerPublicationMemoryExternalSample {
  try {
    const sample = sampler.sample();
    return {
      source: sample.source,
      rssBytes: safeNullableBytes(sample.rssBytes),
      physicalFootprintBytes: safeNullableBytes(sample.physicalFootprintBytes),
      privateResidentBytes: safeNullableBytes(sample.privateResidentBytes),
      workingSetBytes: safeNullableBytes(sample.workingSetBytes),
      privateCommittedBytes: safeNullableBytes(sample.privateCommittedBytes),
    };
  } catch {
    return unavailableExternalSample(platform);
  }
}

function unavailableExternalSample(platform: NodeJS.Platform): ProjectLedgerPublicationMemoryExternalSample {
  return {
    source: memorySourceForPlatform(platform),
    rssBytes: null,
    physicalFootprintBytes: null,
    privateResidentBytes: null,
    workingSetBytes: null,
    privateCommittedBytes: null,
  };
}

function readInternalMemory(memoryUsage: () => NodeJS.MemoryUsage): ProjectLedgerPublicationMemoryCycle["internal"] {
  try {
    const memory = memoryUsage();
    return {
      rssBytes: safeNullableBytes(memory.rss),
      heapUsedBytes: safeNullableBytes(memory.heapUsed),
      externalBytes: safeNullableBytes(memory.external),
      arrayBufferBytes: safeNullableBytes(memory.arrayBuffers),
    };
  } catch {
    return {
      rssBytes: null,
      heapUsedBytes: null,
      externalBytes: null,
      arrayBufferBytes: null,
    };
  }
}

function evidenceWithGate(
  platform: NodeJS.Platform,
  corpus: ProjectLedgerPublicationMemoryEvidence["corpus"],
  cycles: ProjectLedgerPublicationMemoryCycle[],
  gate: ProjectLedgerPublicationMemoryGate,
): ProjectLedgerPublicationMemoryEvidence {
  return {
    schema: PROJECT_LEDGER_PUBLICATION_MEMORY_SCHEMA,
    platform,
    corpus,
    cycles,
    gate,
    privacy: {
      rawPathsIncluded: false,
      rawRecordContentsIncluded: false,
      processIdentityIncluded: false,
    },
  };
}

function safeMonotonicMs(clock: () => number): number {
  try {
    const value = clock();
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function safeNullableBytes(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

async function safeCycleMarker<T>(
  callback: ((value: T) => void | Promise<void>) | undefined,
  value: T,
): Promise<void> {
  if (!callback) return;
  try {
    await callback(value);
  } catch {
    // Evidence markers are advisory and must never alter publication execution.
  }
}
