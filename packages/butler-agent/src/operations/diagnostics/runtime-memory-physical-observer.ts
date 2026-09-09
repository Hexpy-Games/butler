import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeMemoryAttributionEvent } from "./runtime-memory-attribution/contracts.ts";

const MAX_SEGMENT_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 2_048;
const PREVIOUS_FILE = "agent-memory-physical.previous.jsonl";

export type RuntimeMemoryPhysicalObserverEvent = RuntimeMemoryAttributionEvent | "other";

export type RuntimeMemoryPhysicalObserverCounters = {
  rssBytes: number | null;
  physicalFootprintBytes: number | null;
  privateResidentBytes: number | null;
  workingSetBytes: number | null;
  privateCommittedBytes: number | null;
  compressedBytes: number | null;
  swapBytes: number | null;
  unsupportedReasons: Record<string, string>;
};

export type RuntimeMemoryPhysicalObserverRecord = {
  schema: "butler.agent-memory-physical.v1";
  sequence: number;
  monotonicMs: number;
  wallClockMs: number;
  role: "agent_runtime";
  event: RuntimeMemoryPhysicalObserverEvent;
  runtimeVersion: string;
  counters: RuntimeMemoryPhysicalObserverCounters;
};

export type RuntimeMemoryPhysicalObserverOptions = {
  pid: number;
  outputPath: string;
  platform?: NodeJS.Platform;
  run?: (command: string, args: readonly string[]) => string;
  readFile?: (path: string) => string;
  clock?: {
    monotonicMs?: () => number;
    wallClockMs?: () => number;
  };
  runtimeVersion?: string;
};

export interface RuntimeMemoryPhysicalObserver {
  sample(event: RuntimeMemoryPhysicalObserverEvent): void;
  close(): void;
}

export function createRuntimeMemoryPhysicalObserver(
  options: RuntimeMemoryPhysicalObserverOptions,
): RuntimeMemoryPhysicalObserver {
  return new PhysicalObserver(options);
}

class PhysicalObserver implements RuntimeMemoryPhysicalObserver {
  private readonly pid: number;
  private readonly platform: NodeJS.Platform;
  private readonly outputPath: string;
  private readonly run: (command: string, args: readonly string[]) => string;
  private readonly readFile: (path: string) => string;
  private readonly monotonicMs: () => number;
  private readonly wallClockMs: () => number;
  private readonly runtimeVersion: string;
  private fd: number | null = null;
  private bytesWritten = 0;
  private eventsWritten = 0;
  private sequence = 0;
  private closed = false;

  constructor(options: RuntimeMemoryPhysicalObserverOptions) {
    this.pid = options.pid;
    this.platform = options.platform ?? process.platform;
    this.outputPath = options.outputPath;
    this.run = options.run ?? ((command, args) => execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }));
    this.readFile = options.readFile ?? ((path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    });
    this.monotonicMs = options.clock?.monotonicMs ?? (() => performance.now());
    this.wallClockMs = options.clock?.wallClockMs ?? (() => Date.now());
    this.runtimeVersion = sanitizeRuntimeVersion(
      options.runtimeVersion ?? process.versions.bun ?? process.version,
    );
    try {
      this.openWriter();
    } catch {
      this.fd = null;
    }
  }

  sample(event: RuntimeMemoryPhysicalObserverEvent): void {
    if (this.closed || this.eventsWritten >= MAX_EVENTS || this.fd === null) return;
    try {
      const record: RuntimeMemoryPhysicalObserverRecord = {
        schema: "butler.agent-memory-physical.v1",
        sequence: this.sequence++,
        monotonicMs: safeNumber(this.monotonicMs()),
        wallClockMs: safeNumber(this.wallClockMs()),
        role: "agent_runtime",
        event: sanitizeEvent(event),
        runtimeVersion: this.runtimeVersion,
        counters: this.readCounters(),
      };
      const line = `${JSON.stringify(record)}\n`;
      const byteLength = Buffer.byteLength(line, "utf8");
      if (byteLength > MAX_SEGMENT_BYTES) return;
      if (this.bytesWritten + byteLength > MAX_SEGMENT_BYTES) this.rotateWriter();
      if (this.fd === null) return;
      writeSync(this.fd, line, undefined, "utf8");
      this.bytesWritten += byteLength;
      this.eventsWritten += 1;
    } catch {
      // Physical sampling is an external diagnostic observer. It never
      // propagates a command, parser, or filesystem failure to the Agent.
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // Best effort only.
    }
    this.fd = null;
  }

  private readCounters(): RuntimeMemoryPhysicalObserverCounters {
    const unsupportedReasons: Record<string, string> = {};
    const rssBytes = this.readRss();
    if (rssBytes === null) unsupportedReasons.rssBytes = "rss_unavailable";
    if (this.platform === "darwin") {
      const physicalFootprintBytes = this.readDarwinFootprint();
      if (physicalFootprintBytes === null) {
        unsupportedReasons.physicalFootprintBytes = "physical_footprint_unavailable";
      }
      unsupportedReasons.privateResidentBytes = "darwin_private_resident_unavailable";
      unsupportedReasons.workingSetBytes = "darwin_working_set_unavailable";
      unsupportedReasons.privateCommittedBytes = "darwin_private_committed_unavailable";
      unsupportedReasons.compressedBytes = "darwin_compressed_counter_unavailable";
      unsupportedReasons.swapBytes = "darwin_process_swap_counter_unavailable";
      return {
        rssBytes,
        physicalFootprintBytes,
        privateResidentBytes: null,
        workingSetBytes: null,
        privateCommittedBytes: null,
        compressedBytes: null,
        swapBytes: null,
        unsupportedReasons,
      };
    }
    if (this.platform === "linux") {
      const smaps = safeRead(this.readFile, `/proc/${this.pid}/smaps_rollup`);
      const status = safeRead(this.readFile, `/proc/${this.pid}/status`);
      const privateClean = parseKiB(smaps, /^Private_Clean:\s*(\d+)\s*kB$/mu);
      const privateDirty = parseKiB(smaps, /^Private_Dirty:\s*(\d+)\s*kB$/mu);
      const swap = parseKiB(status, /^VmSwap:\s*(\d+)\s*kB$/mu);
      const privateResidentBytes = privateClean !== null && privateDirty !== null
        ? privateClean + privateDirty
        : null;
      if (privateResidentBytes === null) {
        unsupportedReasons.privateResidentBytes = "linux_private_resident_unavailable";
      }
      unsupportedReasons.workingSetBytes = "linux_working_set_unavailable";
      unsupportedReasons.privateCommittedBytes = "linux_private_committed_unavailable";
      if (swap === null) unsupportedReasons.swapBytes = "linux_swap_unavailable";
      unsupportedReasons.physicalFootprintBytes = "linux_physical_footprint_unavailable";
      unsupportedReasons.compressedBytes = "linux_compressed_counter_unavailable";
      return {
        rssBytes,
        physicalFootprintBytes: null,
        privateResidentBytes,
        workingSetBytes: null,
        privateCommittedBytes: null,
        compressedBytes: null,
        swapBytes: swap,
        unsupportedReasons,
      };
    }
    const windows = this.platform === "win32" ? this.readWindowsCounters() : null;
    if (this.platform === "win32") {
      if (windows?.workingSetBytes === null) {
        unsupportedReasons.workingSetBytes = "windows_working_set_unavailable";
      }
      if (windows?.privateCommittedBytes === null) {
        unsupportedReasons.privateCommittedBytes = "windows_private_committed_unavailable";
      }
    }
    unsupportedReasons.physicalFootprintBytes = "platform_physical_footprint_unavailable";
    unsupportedReasons.privateResidentBytes = "platform_private_resident_unavailable";
    if (this.platform !== "win32") {
      unsupportedReasons.workingSetBytes = "platform_working_set_unavailable";
      unsupportedReasons.privateCommittedBytes = "platform_private_committed_unavailable";
    }
    unsupportedReasons.compressedBytes = "platform_compressed_counter_unavailable";
    unsupportedReasons.swapBytes = "platform_swap_unavailable";
    return {
      rssBytes,
      physicalFootprintBytes: null,
      privateResidentBytes: null,
      workingSetBytes: windows?.workingSetBytes ?? null,
      privateCommittedBytes: windows?.privateCommittedBytes ?? null,
      compressedBytes: null,
      swapBytes: null,
      unsupportedReasons,
    };
  }

  private readRss(): number | null {
    const output = safeRun(this.run, "ps", ["-o", "rss=", "-p", String(this.pid)]);
    const value = Number(output.trim());
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value * 1024) : null;
  }

  private readDarwinFootprint(): number | null {
    const output = safeRun(this.run, "footprint", [
      "--pid", String(this.pid), "--format", "bytes", "--noCategories",
    ]);
    const value = output.match(/phys_footprint:\s*([\d.]+)\s*(?:bytes?|B)/iu)?.[1];
    const parsed = value ? Number(value) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
  }

  private readWindowsCounters(): {
    workingSetBytes: number | null;
    privateCommittedBytes: number | null;
  } {
    const output = safeRun(this.run, "powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$process = Get-Process -Id ${this.pid}; Write-Output $process.WorkingSet64; Write-Output $process.PrivateMemorySize64`,
    ]);
    const values = output.split(/\s+/u)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .map((value) => Math.trunc(value));
    return {
      workingSetBytes: values[0] ?? null,
      privateCommittedBytes: values[1] ?? null,
    };
  }

  private openWriter(): void {
    const directory = dirname(this.outputPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const previous = join(directory, PREVIOUS_FILE);
    if (existsSync(this.outputPath)) {
      try {
        rmSync(previous, { force: true });
        renameSync(this.outputPath, previous);
        chmodSync(previous, 0o600);
      } catch {
        // A corrupt prior segment is disposable evidence; do not read it.
      }
    }
    this.fd = openSync(this.outputPath, "a", 0o600);
    chmodSync(this.outputPath, 0o600);
    this.bytesWritten = statSync(this.outputPath).size;
  }

  private rotateWriter(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    const previous = join(dirname(this.outputPath), PREVIOUS_FILE);
    rmSync(previous, { force: true });
    if (existsSync(this.outputPath)) renameSync(this.outputPath, previous);
    this.fd = openSync(this.outputPath, "a", 0o600);
    chmodSync(this.outputPath, 0o600);
    this.bytesWritten = 0;
  }
}

function safeRun(
  run: (command: string, args: readonly string[]) => string,
  command: string,
  args: readonly string[],
): string {
  try {
    return run(command, args);
  } catch {
    return "";
  }
}

function safeRead(readFile: (path: string) => string, path: string): string {
  try {
    return readFile(path);
  } catch {
    return "";
  }
}

function parseKiB(value: string, pattern: RegExp): number | null {
  const parsed = Number(value.match(pattern)?.[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed * 1024) : null;
}

function safeNumber(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function sanitizeRuntimeVersion(value: string): string {
  return /^[\w.+-]{1,64}$/u.test(value) ? value : "unknown";
}

function sanitizeEvent(value: RuntimeMemoryPhysicalObserverEvent): RuntimeMemoryPhysicalObserverEvent {
  switch (value) {
    case "turn_start":
    case "turn_end":
    case "model_call_start":
    case "model_call_end":
    case "model_call_failure":
    case "tool_call_start":
    case "tool_call_end":
    case "tool_call_failure":
    case "terminal_state":
    case "idle_checkpoint":
    case "idle_pre_gc":
    case "idle_post_gc":
    case "other":
      return value;
    default:
      return "other";
  }
}
