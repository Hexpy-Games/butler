import type { ProjectLedgerEffectResult } from
  "../../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/external-effect-mutation.ts";
import type { ProjectLedgerRecordUpdate } from
  "../../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/external-effect-record-update.ts";

export const PROJECT_LEDGER_PUBLICATION_MEMORY_SCHEMA =
  "butler.project-ledger-publication-memory.v1" as const;
export const PROJECT_LEDGER_MEMORY_BUDGET_BYTES = 768 * 1024 * 1024;
export const PROJECT_LEDGER_REQUIRED_RECORDS = 3_000;
export const PROJECT_LEDGER_REQUIRED_BYTES = 100 * 1024 * 1024;
export const PROJECT_LEDGER_POST_WARMUP_GROWTH_RATIO = 1.1;
export const PROJECT_LEDGER_MIN_STEADY_CYCLES = 6;
export const PROJECT_LEDGER_DEFAULT_STEADY_CYCLES = PROJECT_LEDGER_MIN_STEADY_CYCLES;
export const PROJECT_LEDGER_MAX_STEADY_CYCLES = 12;

export type MemorySource = "physical_footprint" | "private_resident" | "working_set";
export type GateStatus = "pass" | "fail" | "unavailable";
export type CyclePhase = "warmup" | "steady";

export type ProjectLedgerPublicationMemoryExternalSample = {
  source: MemorySource | null;
  rssBytes: number | null;
  physicalFootprintBytes: number | null;
  privateResidentBytes: number | null;
  workingSetBytes: number | null;
  privateCommittedBytes: number | null;
};

export type ProjectLedgerPublicationMemoryCycle = {
  index: number;
  phase: CyclePhase;
  durationMs: number | null;
  completed: boolean;
  internal: {
    rssBytes: number | null;
    heapUsedBytes: number | null;
    externalBytes: number | null;
    arrayBufferBytes: number | null;
  };
  external: ProjectLedgerPublicationMemoryExternalSample;
};

export type ProjectLedgerPublicationMemoryGate = {
  status: GateStatus;
  budgetBytes: number;
  memorySource: MemorySource | null;
  steadyCycleCount: number;
  baselineBytes: number | null;
  peakBytes: number | null;
  finalBytes: number | null;
  peakToBaselineRatio: number | null;
  privateCommittedPeakBytes: number | null;
  failureCodes: string[];
};

export type ProjectLedgerPublicationMemoryEvidence = {
  schema: typeof PROJECT_LEDGER_PUBLICATION_MEMORY_SCHEMA;
  platform: NodeJS.Platform;
  corpus: {
    recordCount: number;
    totalBytes: number;
    requiredRecords: number;
    requiredBytes: number;
  };
  cycles: ProjectLedgerPublicationMemoryCycle[];
  gate: ProjectLedgerPublicationMemoryGate;
  privacy: {
    rawPathsIncluded: false;
    rawRecordContentsIncluded: false;
    processIdentityIncluded: false;
  };
};

export type ProjectLedgerExternalMemorySampler = {
  sample(): ProjectLedgerPublicationMemoryExternalSample;
  close(): void;
};

export type ProjectLedgerPublicationMemoryRunnerInput = {
  ledgerRoot: string;
  butlerData: string;
  recordId: string;
  recordKind?: string;
  platform?: NodeJS.Platform;
  steadyCycles?: number;
  minimumCorpus?: {
    recordCount?: number;
    totalBytes?: number;
  };
};

export type ProjectLedgerPublicationMemoryRunnerDependencies = {
  applyPublication?: (input: {
    butlerData: string;
    projectRoot: string;
    effectKey: string;
    updates: ProjectLedgerRecordUpdate[];
  }) => Promise<ProjectLedgerEffectResult>;
  createSampler?: (platform: NodeJS.Platform) => ProjectLedgerExternalMemorySampler;
  memoryUsage?: () => NodeJS.MemoryUsage;
  monotonicMs?: () => number;
  onCycleStart?: (cycle: { index: number; phase: CyclePhase }) => void | Promise<void>;
  onCycleEnd?: (cycle: {
    index: number;
    phase: CyclePhase;
    durationMs: number;
    completed: boolean;
  }) => void | Promise<void>;
};
