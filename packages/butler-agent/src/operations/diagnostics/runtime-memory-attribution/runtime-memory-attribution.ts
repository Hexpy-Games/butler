import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
// Bun exposes these counters from bun:jsc.
import { heapStats as bunHeapStats } from "bun:jsc";
import {
  RUNTIME_MEMORY_ATTRIBUTION_SCHEMA,
  type RuntimeMemoryAttributionCheckpoint,
  type RuntimeMemoryAttributionHeapCounters,
  type RuntimeMemoryAttributionOwnerCounts,
  type RuntimeMemoryAttributionOperation,
  type RuntimeMemoryAttributionPhaseStatus,
  type RuntimeMemoryAttributionPort,
  type RuntimeMemoryAttributionProjectLedgerPhase,
  type RuntimeMemoryAttributionProcessCounters,
  type RuntimeMemoryAttributionRecord,
  type RuntimeMemoryAttributionTerminalState,
} from "./contracts.ts";

const ENABLE_ENV = "BUTLER_AGENT_MEMORY_DIAGNOSTICS";
const GC_PROBE_ENV = "BUTLER_AGENT_MEMORY_DIAGNOSTICS_GC_PROBE";
const DIAGNOSTICS_DIRECTORY = "diagnostics";
const CURRENT_FILE = "agent-memory-attribution.jsonl";
const PREVIOUS_FILE = "agent-memory-attribution.previous.jsonl";
const GC_MARKER_FILE = "allow-isolated-gc-probe";
const DEFAULT_MAX_SEGMENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 2_048;
const DEFAULT_IDLE_DELAY_MS = 1_000;
const MAX_IDLE_DELAY_MS = 60_000;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const MAX_OWNER_COUNT = 100_000;

type RuntimeMemoryAttributionState = "disabled" | "enabled" | "isolated_gc" | "degraded" | "closed";

type BunHeapStats = {
  heapSize?: unknown;
  heapCapacity?: unknown;
  extraMemorySize?: unknown;
  objectCount?: unknown;
};

type Clock = {
  monotonicMs: () => number;
  wallClockMs: () => number;
};

export type RuntimeMemoryAttributionOptions = {
  butlerData: string;
  env?: Readonly<Record<string, string | undefined>>;
  idleDelayMs?: number;
  maxSegmentBytes?: number;
  maxEvents?: number;
  processMemoryUsage?: () => NodeJS.MemoryUsage;
  heapStats?: () => BunHeapStats;
  gc?: (full: boolean) => void;
  clock?: Partial<Clock>;
};

export type RuntimeMemoryAttributionPhaseRunInput<T> = {
  attribution?: RuntimeMemoryAttributionPort;
  phase: RuntimeMemoryAttributionProjectLedgerPhase;
  run: () => T;
  failed?: (result: T) => boolean;
  now?: () => number;
};

export function createNoopRuntimeMemoryAttributionPort(): RuntimeMemoryAttributionPort {
  return {
    checkpoint() {},
    projectLedgerPhase() {},
    terminal() {},
    close() {},
  };
}

export function runRuntimeMemoryAttributionPhase<T>(
  input: RuntimeMemoryAttributionPhaseRunInput<T>,
): T {
  const now = input.now ?? (() => performance.now());
  const startedAt = safePhaseClock(now);
  emitProjectLedgerPhase(input.attribution, {
    phase: input.phase,
    status: "start",
  });
  try {
    const result = input.run();
    emitProjectLedgerPhase(input.attribution, {
      phase: input.phase,
      status: input.failed?.(result) === true ? "failure" : "end",
      durationMs: elapsedPhaseMs(now, startedAt),
    });
    return result;
  } catch (error) {
    emitProjectLedgerPhase(input.attribution, {
      phase: input.phase,
      status: "failure",
      durationMs: elapsedPhaseMs(now, startedAt),
    });
    throw error;
  }
}

export async function runRuntimeMemoryAttributionAsyncPhase<T>(
  input: Omit<RuntimeMemoryAttributionPhaseRunInput<T>, "run"> & { run: () => Promise<T> },
): Promise<T> {
  const now = input.now ?? (() => performance.now());
  const startedAt = safePhaseClock(now);
  emitProjectLedgerPhase(input.attribution, {
    phase: input.phase,
    status: "start",
  });
  try {
    const result = await input.run();
    emitProjectLedgerPhase(input.attribution, {
      phase: input.phase,
      status: input.failed?.(result) === true ? "failure" : "end",
      durationMs: elapsedPhaseMs(now, startedAt),
    });
    return result;
  } catch (error) {
    emitProjectLedgerPhase(input.attribution, {
      phase: input.phase,
      status: "failure",
      durationMs: elapsedPhaseMs(now, startedAt),
    });
    throw error;
  }
}

function emitProjectLedgerPhase(
  attribution: RuntimeMemoryAttributionPort | undefined,
  input: {
    phase: RuntimeMemoryAttributionProjectLedgerPhase;
    status: RuntimeMemoryAttributionPhaseStatus;
    durationMs?: number;
  },
): void {
  try {
    attribution?.projectLedgerPhase(input);
  } catch {
    // Diagnostics must not alter the Project Ledger result or Turn.
  }
}

function safePhaseClock(clock: () => number): number {
  try {
    const value = clock();
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function elapsedPhaseMs(clock: () => number, startedAt: number): number {
  return Math.max(0, safePhaseClock(clock) - startedAt);
}

export function createRuntimeMemoryAttributionPort(
  options: RuntimeMemoryAttributionOptions,
): RuntimeMemoryAttributionPort {
  const env = options.env ?? process.env;
  if (env[ENABLE_ENV] !== "1") return createNoopRuntimeMemoryAttributionPort();

  try {
    return new RuntimeMemoryAttributionWriter(options);
  } catch {
    // Diagnostics are disposable evidence. A failed setup must not alter the
    // primary Agent lifecycle or turn admission path.
    return new RuntimeMemoryAttributionWriter(options, "degraded");
  }
}

class RuntimeMemoryAttributionWriter implements RuntimeMemoryAttributionPort {
  private readonly diagnosticsDirectory: string;
  private readonly currentFile: string;
  private readonly previousFile: string;
  private readonly markerFile: string;
  private readonly maxSegmentBytes: number;
  private readonly maxEvents: number;
  private readonly idleDelayMs: number;
  private readonly processMemoryUsage: () => NodeJS.MemoryUsage;
  private readonly heapStats: () => BunHeapStats;
  private readonly gc: (full: boolean) => void;
  private readonly clock: Clock;
  private readonly isolatedGcAuthorized: boolean;
  private state: RuntimeMemoryAttributionState;
  private fd: number | null = null;
  private bytesWritten = 0;
  private eventsWritten = 0;
  private sequence = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private gcProbeUsed = false;
  private activeTurns = 0;
  private terminalObserved = false;
  private activeProviderStreams = 0;
  private activeToolCalls = 0;

  constructor(
    options: RuntimeMemoryAttributionOptions,
    initialState?: RuntimeMemoryAttributionState,
  ) {
    this.diagnosticsDirectory = join(options.butlerData, DIAGNOSTICS_DIRECTORY);
    this.currentFile = join(this.diagnosticsDirectory, CURRENT_FILE);
    this.previousFile = join(this.diagnosticsDirectory, PREVIOUS_FILE);
    this.markerFile = join(this.diagnosticsDirectory, GC_MARKER_FILE);
    this.maxSegmentBytes = boundedPositiveInteger(
      options.maxSegmentBytes,
      DEFAULT_MAX_SEGMENT_BYTES,
      DEFAULT_MAX_SEGMENT_BYTES,
    );
    this.maxEvents = boundedPositiveInteger(options.maxEvents, DEFAULT_MAX_EVENTS, DEFAULT_MAX_EVENTS);
    this.idleDelayMs = boundedPositiveInteger(options.idleDelayMs, DEFAULT_IDLE_DELAY_MS, MAX_IDLE_DELAY_MS);
    this.processMemoryUsage = options.processMemoryUsage ?? (() => process.memoryUsage());
    this.heapStats = options.heapStats ?? (() => bunHeapStats() as BunHeapStats);
    this.gc = options.gc ?? ((full) => {
      const candidate = (globalThis as {
        Bun?: { gc?: (force?: boolean) => void };
      }).Bun?.gc;
      if (typeof candidate !== "function") throw new Error("bun_gc_unavailable");
      candidate(full);
    });
    this.clock = {
      monotonicMs: options.clock?.monotonicMs ?? (() => performance.now()),
      wallClockMs: options.clock?.wallClockMs ?? (() => Date.now()),
    };
    this.isolatedGcAuthorized = (options.env ?? process.env)[GC_PROBE_ENV] === "1" &&
      hasMode0600Marker(this.markerFile);
    this.state = initialState ?? (this.isolatedGcAuthorized ? "isolated_gc" : "enabled");

    if (this.state === "degraded") return;
    mkdirSync(this.diagnosticsDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.diagnosticsDirectory, 0o700);
    rotateExistingSegments(this.currentFile, this.previousFile);
    this.openCurrentFile();
  }

  checkpoint(input: RuntimeMemoryAttributionCheckpoint): void {
    if (input.event === "turn_start") {
      this.activeTurns += 1;
      this.cancelIdleTimer();
    }
    const ownerCounts = this.updateOwnerCounts(input.event, input.ownerCounts);
    this.writeCheckpoint({ ...input, ownerCounts }, null);
    if (input.event === "turn_end") {
      this.activeTurns = Math.max(0, this.activeTurns - 1);
      this.scheduleIdleIfQuiescent();
    }
  }

  projectLedgerPhase(input: {
    phase: RuntimeMemoryAttributionProjectLedgerPhase;
    status: RuntimeMemoryAttributionPhaseStatus;
    durationMs?: number;
  }): void {
    if (!isRuntimeMemoryAttributionProjectLedgerPhase(input.phase)) return;
    if (!isRuntimeMemoryAttributionPhaseStatus(input.status)) return;
    this.checkpoint({
      event: "project_ledger_phase",
      operation: "project_ledger",
      phase: input.phase,
      phaseStatus: input.status,
      durationMs: input.durationMs,
    });
  }

  terminal(state: RuntimeMemoryAttributionTerminalState): void {
    if (this.state === "disabled" || this.state === "closed") return;
    this.terminalObserved = true;
    this.checkpoint({ event: "terminal_state", operation: "terminal", terminalState: state });
    this.scheduleIdleIfQuiescent();
  }

  private scheduleIdleIfQuiescent(): void {
    if (!this.terminalObserved || this.activeTurns > 0 || this.idleTimer !== null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.state === "closed" || this.state === "disabled") return;
      this.checkpoint({ event: "idle_checkpoint" });
      this.terminalObserved = false;
      if (this.state !== "isolated_gc" || this.gcProbeUsed) return;
      this.gcProbeUsed = true;
      this.writeCheckpoint({ event: "idle_pre_gc" }, "before");
      try {
        this.gc(true);
      } catch {
        // The absence of Bun.gc is itself an unsupported probe; the Agent
        // remains unaffected and the pre-GC sample is still useful evidence.
        return;
      }
      this.writeCheckpoint({ event: "idle_post_gc" }, "after");
    }, this.idleDelayMs);
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  close(): void {
    if (this.state === "closed") return;
    this.cancelIdleTimer();
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // Close is best-effort and must be idempotent.
      }
      this.fd = null;
    }
    this.state = "closed";
  }

  private writeCheckpoint(
    input: RuntimeMemoryAttributionCheckpoint,
    gcProbe: "before" | "after" | null,
  ): void {
    if (this.state === "disabled" || this.state === "closed") return;
    if (this.eventsWritten >= this.maxEvents) return;
    try {
      const record = this.capture({
        ...input,
        ownerCounts: {
          ...safeOwnerCounts(input.ownerCounts),
          activeProviderStreams: this.activeProviderStreams,
          activeToolCalls: this.activeToolCalls,
        },
      }, gcProbe);
      const line = `${JSON.stringify(record)}\n`;
      const byteLength = Buffer.byteLength(line, "utf8");
      if (byteLength > this.maxSegmentBytes) return;
      if (this.fd === null || this.bytesWritten + byteLength > this.maxSegmentBytes) {
        this.rotateCurrentFile();
      }
      if (this.fd === null) return;
      writeSync(this.fd, line, undefined, "utf8");
      this.bytesWritten += byteLength;
      this.eventsWritten += 1;
    } catch {
      // A diagnostic failure cannot reject, retry, or alter a Turn. Keep the
      // writer available for a later checkpoint so transient filesystem or
      // counter failures remain observable without retaining an error string.
      this.state = "degraded";
    }
  }

  private updateOwnerCounts(
    event: RuntimeMemoryAttributionCheckpoint["event"],
    supplied: RuntimeMemoryAttributionOwnerCounts | undefined,
  ): RuntimeMemoryAttributionOwnerCounts {
    if (event === "model_call_start") this.activeProviderStreams += 1;
    if (event === "model_call_end" || event === "model_call_failure") {
      this.activeProviderStreams = Math.max(0, this.activeProviderStreams - 1);
    }
    if (event === "tool_call_start") this.activeToolCalls += 1;
    if (event === "tool_call_end" || event === "tool_call_failure") {
      this.activeToolCalls = Math.max(0, this.activeToolCalls - 1);
    }
    const ownerCounts = safeOwnerCounts(supplied);
    ownerCounts.activeProviderStreams = this.activeProviderStreams;
    ownerCounts.activeToolCalls = this.activeToolCalls;
    return ownerCounts;
  }

  private capture(
    input: RuntimeMemoryAttributionCheckpoint,
    gcProbe: "before" | "after" | null,
  ): RuntimeMemoryAttributionRecord {
    const memory = safeProcessMemory(this.processMemoryUsage());
    const heap = safeHeapStats(this.heapStats());
    return {
      schema: RUNTIME_MEMORY_ATTRIBUTION_SCHEMA,
      sequence: this.sequence++,
      monotonicMs: safeNumber(this.clock.monotonicMs(), 0, MAX_COUNTER),
      wallClockMs: safeNumber(this.clock.wallClockMs(), 0, MAX_COUNTER),
      event: input.event,
      operation: sanitizeOperation(input.operation),
      durationMs: optionalNumber(input.durationMs, 0, 86_400_000),
      iteration: optionalNumber(input.iteration, 0, 1_000_000),
      windowIndex: optionalNumber(input.windowIndex, 0, 1_000_000),
      terminalState: input.terminalState ?? null,
      phase: sanitizeProjectLedgerPhase(input.phase),
      phaseStatus: sanitizePhaseStatus(input.phaseStatus),
      process: memory,
      heap,
      ownerCounts: safeOwnerCounts(input.ownerCounts),
      gcProbe,
    };
  }

  private openCurrentFile(): void {
    this.fd = openSync(this.currentFile, "a", 0o600);
    chmodSync(this.currentFile, 0o600);
    try {
      this.bytesWritten = statSync(this.currentFile).size;
    } catch {
      this.bytesWritten = 0;
    }
  }

  private rotateCurrentFile(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // The next open attempt determines whether the writer recovered.
      }
      this.fd = null;
    }
    rotateExistingSegments(this.currentFile, this.previousFile);
    this.bytesWritten = 0;
    this.openCurrentFile();
  }
}

function rotateExistingSegments(currentFile: string, previousFile: string): void {
  try {
    rmSync(previousFile, { force: true });
  } catch {
    // A stale previous segment is disposable evidence.
  }
  if (!existsSync(currentFile)) return;
  try {
    renameSync(currentFile, previousFile);
    chmodSync(previousFile, 0o600);
  } catch {
    // If a corrupt or concurrently removed file cannot be rotated, the next
    // append remains failure-isolated and never reads the file into memory.
  }
}

function hasMode0600Marker(path: string): boolean {
  try {
    const mode = statSync(path).mode & 0o777;
    return mode === 0o600;
  } catch {
    return false;
  }
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value) || !value || value < 1) return fallback;
  return Math.min(Math.trunc(value), maximum);
}

function safeNumber(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function optionalNumber(value: unknown, minimum: number, maximum: number): number | null {
  return value === undefined ? null : safeNumber(value, minimum, maximum);
}

function safeProcessMemory(memory: NodeJS.MemoryUsage): RuntimeMemoryAttributionProcessCounters {
  return {
    rssBytes: safeNumber(memory?.rss, 0, MAX_COUNTER),
    heapTotalBytes: safeNumber(memory?.heapTotal, 0, MAX_COUNTER),
    heapUsedBytes: safeNumber(memory?.heapUsed, 0, MAX_COUNTER),
    externalBytes: safeNumber(memory?.external, 0, MAX_COUNTER),
    arrayBufferBytes: safeNumber(memory?.arrayBuffers, 0, MAX_COUNTER),
  };
}

function safeHeapStats(stats: BunHeapStats): RuntimeMemoryAttributionHeapCounters {
  return {
    heapSizeBytes: safeNullableCounter(stats?.heapSize),
    heapCapacityBytes: safeNullableCounter(stats?.heapCapacity),
    extraMemoryBytes: safeNullableCounter(stats?.extraMemorySize),
    objectCount: safeNullableCounter(stats?.objectCount),
  };
}

function safeNullableCounter(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return safeNumber(value, 0, MAX_COUNTER);
}

function safeOwnerCounts(
  counts: RuntimeMemoryAttributionOwnerCounts | undefined,
): RuntimeMemoryAttributionOwnerCounts {
  if (!counts) return {};
  const output: RuntimeMemoryAttributionOwnerCounts = {};
  for (const key of [
    "activeProviderStreams",
    "activeToolCalls",
    "activeTerminalProcesses",
    "activeLanceDbHandles",
    "activeFetchReaders",
  ] as const) {
    const value = counts[key];
    if (value !== undefined) output[key] = safeNumber(value, 0, MAX_OWNER_COUNT);
  }
  return output;
}

function sanitizeOperation(value: unknown): RuntimeMemoryAttributionOperation {
  switch (value) {
    case "provider":
    case "command":
    case "web":
    case "filesystem":
    case "memory":
    case "project_ledger":
    case "work_tracking":
    case "other_tool":
    case "terminal":
    case "window":
    case "turn":
    case "other":
      return value;
    default:
      return "other";
  }
}

function sanitizeProjectLedgerPhase(
  value: unknown,
): RuntimeMemoryAttributionProjectLedgerPhase | null {
  return isRuntimeMemoryAttributionProjectLedgerPhase(value) ? value : null;
}

function isRuntimeMemoryAttributionProjectLedgerPhase(
  value: unknown,
): value is RuntimeMemoryAttributionProjectLedgerPhase {
  switch (value) {
    case "work_update":
    case "observe_base":
    case "source_head":
    case "prepare":
    case "materialize":
    case "copy":
    case "index":
    case "render_dashboard":
    case "render_handoff":
    case "render_roadmap":
    case "write_index":
    case "inspect_publication":
    case "promote":
    case "observe_promotion":
    case "observe_current_head":
    case "check":
      return true;
    default:
      return false;
  }
}

function sanitizePhaseStatus(value: unknown): RuntimeMemoryAttributionPhaseStatus | null {
  return isRuntimeMemoryAttributionPhaseStatus(value) ? value : null;
}

function isRuntimeMemoryAttributionPhaseStatus(value: unknown): value is RuntimeMemoryAttributionPhaseStatus {
  return value === "start" || value === "end" || value === "failure";
}
