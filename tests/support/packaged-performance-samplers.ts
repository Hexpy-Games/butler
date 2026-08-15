import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import type {
  PackagedMetricName,
  PackagedPerformanceSampler,
  PackagedProcessSample,
  PackagedProcessTarget,
  PackagedSystemMemorySample,
} from "./packaged-performance-snapshot.ts";
import {
  countConnections,
  finiteOrNull,
  parseByteValue,
  parseCpuTimeMs,
  parseDarwinFootprint,
  parseDarwinWritableResident,
  parseLinuxKiB,
} from "./packaged-performance-sampling-parsers.ts";

export function readProcessSample(
  target: PackagedProcessTarget,
  platform: NodeJS.Platform,
  sampler: PackagedPerformanceSampler = {},
): PackagedProcessSample {
  const unsupportedReasons: Partial<Record<PackagedMetricName, string>> = {};
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0) {
    return emptyProcessSample(target, "invalid process id");
  }

  const processStat = readPsSample(target.pid, sampler);
  if (processStat.rssBytes === null) unsupportedReasons.rssBytes = "ps did not return RSS";
  if (processStat.virtualSizeBytes === null) unsupportedReasons.virtualSizeBytes = "ps did not return VSZ";

  let physicalFootprintBytes: number | null = null;
  let privateResidentBytes: number | null = null;
  let compressedBytes: number | null = null;
  let swapBytes: number | null = null;
  if (platform === "darwin") {
    const footprint = parseDarwinFootprint(safeRunOrEmpty(sampler, "footprint", [
      "--pid", String(target.pid), "--format", "bytes", "--noCategories",
    ]));
    physicalFootprintBytes = footprint.physicalFootprintBytes;
    if (physicalFootprintBytes === null) {
      unsupportedReasons.physicalFootprintBytes = footprint.reason;
    }
    privateResidentBytes = parseDarwinWritableResident(safeRunOrEmpty(sampler, "vmmap", ["-summary", String(target.pid)]));
    if (privateResidentBytes === null) {
      unsupportedReasons.privateResidentBytes = "vmmap writable-region resident bytes unavailable";
    }
    compressedBytes = null;
    swapBytes = null;
    unsupportedReasons.compressedBytes = "macOS does not expose per-process compressed bytes through footprint";
    unsupportedReasons.swapBytes = "macOS footprint reports physical footprint, not per-process swap bytes";
  } else if (platform === "linux") {
    const smaps = readLinuxSmaps(target.pid, sampler);
    privateResidentBytes = smaps.privateResidentBytes;
    if (privateResidentBytes === null) {
      unsupportedReasons.privateResidentBytes = "Linux smaps_rollup unavailable";
    }
    swapBytes = smaps.swapBytes;
    if (swapBytes === null) unsupportedReasons.swapBytes = "Linux status VmSwap unavailable";
    unsupportedReasons.physicalFootprintBytes = "Linux has no portable physical-footprint counter";
    unsupportedReasons.compressedBytes = "Linux per-process compressed bytes unavailable";
  } else {
    unsupportedReasons.physicalFootprintBytes = `physical footprint unsupported on ${platform}`;
    unsupportedReasons.privateResidentBytes = `private resident unsupported on ${platform}`;
    unsupportedReasons.compressedBytes = `compressed memory unsupported on ${platform}`;
    unsupportedReasons.swapBytes = `swap unsupported on ${platform}`;
  }

  const resources = readResourceCounts(target.pid, platform, sampler);
  if (resources.openHandles === null) unsupportedReasons.openHandles = resources.reason;
  if (resources.connections === null) unsupportedReasons.connections = resources.reason;

  const runtimeMemory = target.pid === process.pid
    ? (sampler.runtimeMemory?.() ?? process.memoryUsage())
    : null;
  const externalHeapBytes = runtimeMemory?.external ?? null;
  if (externalHeapBytes === null) {
    unsupportedReasons.externalHeapBytes = "runtime external heap is only exposed for the current sampler process";
  }
  unsupportedReasons.nativeHeapBytes = "native heap is not exposed by the portable process sampler";

  return {
    ...target,
    cpuPercent: processStat.cpuPercent,
    cpuTimeMs: processStat.cpuTimeMs,
    rssBytes: processStat.rssBytes,
    virtualSizeBytes: processStat.virtualSizeBytes,
    physicalFootprintBytes,
    privateResidentBytes,
    compressedBytes,
    swapBytes,
    nativeHeapBytes: null,
    externalHeapBytes,
    openHandles: resources.openHandles,
    connections: resources.connections,
    unsupportedReasons,
  };
}

export function readSystemMemorySample(
  platform: NodeJS.Platform,
  sampler: PackagedPerformanceSampler,
): PackagedSystemMemorySample {
  if (platform === "darwin") {
    const vmStat = safeRunOrEmpty(sampler, "vm_stat", []);
    const pageSizeText = vmStat.match(/page size of\s+(\d+)\s+bytes/iu)?.[1];
    const pageSize = pageSizeText ? Number(pageSizeText) : null;
    const compressedPages = Number(vmStat.match(/Pages occupied by compressor:\s*([\d.]+)/iu)?.[1]);
    const compressedBytes = pageSize !== null && Number.isFinite(compressedPages)
      ? pageSize * compressedPages
      : null;
    const swapUsage = safeRunOrEmpty(sampler, "sysctl", ["vm.swapusage"]);
    const swapMatch = swapUsage.match(/used\s*=\s*([\d.]+\s*[BKMGTP]+)/iu);
    const swapBytes = parseByteValue(swapMatch?.[1]);
    return {
      compressedBytes,
      swapBytes,
      unsupportedReasons: {
        ...(compressedBytes === null ? { compressedBytes: "vm_stat compressor counter unavailable" } : {}),
        ...(swapBytes === null ? { swapBytes: "sysctl vm.swapusage unavailable" } : {}),
      },
    };
  }
  if (platform === "linux") {
    const meminfo = (sampler.readFile ?? defaultReadFile)("/proc/meminfo");
    const swapTotal = parseLinuxKiB(meminfo, /^SwapTotal:\s*(\d+)\s*kB$/mu);
    const swapFree = parseLinuxKiB(meminfo, /^SwapFree:\s*(\d+)\s*kB$/mu);
    return {
      compressedBytes: null,
      swapBytes: swapTotal !== null && swapFree !== null ? Math.max(0, swapTotal - swapFree) : null,
      unsupportedReasons: {
        compressedBytes: "Linux system compressor counter unavailable",
        ...(swapTotal === null || swapFree === null ? { swapBytes: "Linux /proc/meminfo swap counters unavailable" } : {}),
      },
    };
  }
  return {
    compressedBytes: null,
    swapBytes: null,
    unsupportedReasons: {
      compressedBytes: `system compressed memory unsupported on ${platform}`,
      swapBytes: `system swap unsupported on ${platform}`,
    },
  };
}

function emptyProcessSample(target: PackagedProcessTarget, reason: string): PackagedProcessSample {
  return {
    ...target,
    cpuPercent: null,
    cpuTimeMs: null,
    rssBytes: null,
    virtualSizeBytes: null,
    physicalFootprintBytes: null,
    privateResidentBytes: null,
    compressedBytes: null,
    swapBytes: null,
    nativeHeapBytes: null,
    externalHeapBytes: null,
    openHandles: null,
    connections: null,
    unsupportedReasons: {
      rssBytes: reason,
      virtualSizeBytes: reason,
      physicalFootprintBytes: reason,
      privateResidentBytes: reason,
      compressedBytes: reason,
      swapBytes: reason,
      nativeHeapBytes: reason,
      externalHeapBytes: reason,
      openHandles: reason,
      connections: reason,
    },
  };
}

function readPsSample(pid: number, sampler: PackagedPerformanceSampler): {
  cpuPercent: number | null;
  cpuTimeMs: number | null;
  rssBytes: number | null;
  virtualSizeBytes: number | null;
} {
  try {
    const output = safeRun(sampler, "ps", [
      "-o", "%cpu=", "-o", "rss=", "-o", "vsz=", "-o", "time=", "-p", String(pid),
    ]).trim();
    const [cpuText, rssKiBText, vszKiBText, cpuTimeText] = output.split(/\s+/u);
    const rssKiB = Number(rssKiBText);
    const vszKiB = Number(vszKiBText);
    return {
      cpuPercent: finiteOrNull(Number(cpuText)),
      cpuTimeMs: parseCpuTimeMs(cpuTimeText),
      rssBytes: Number.isFinite(rssKiB) ? rssKiB * 1024 : null,
      virtualSizeBytes: Number.isFinite(vszKiB) ? vszKiB * 1024 : null,
    };
  } catch {
    return { cpuPercent: null, cpuTimeMs: null, rssBytes: null, virtualSizeBytes: null };
  }
}

function readLinuxSmaps(pid: number, sampler: PackagedPerformanceSampler): {
  privateResidentBytes: number | null;
  swapBytes: number | null;
} {
  const read = sampler.readFile ?? defaultReadFile;
  const smaps = read(`/proc/${pid}/smaps_rollup`);
  const status = read(`/proc/${pid}/status`);
  const privateClean = parseLinuxKiB(smaps, /^Private_Clean:\s*(\d+)\s*kB$/mu);
  const privateDirty = parseLinuxKiB(smaps, /^Private_Dirty:\s*(\d+)\s*kB$/mu);
  const swap = parseLinuxKiB(status, /^VmSwap:\s*(\d+)\s*kB$/mu);
  return {
    privateResidentBytes: privateClean !== null && privateDirty !== null
      ? privateClean + privateDirty
      : null,
    swapBytes: swap,
  };
}

function readResourceCounts(pid: number, platform: NodeJS.Platform, sampler: PackagedPerformanceSampler): {
  openHandles: number | null;
  connections: number | null;
  reason: string;
} {
  if (platform === "linux") {
    try {
      const list = sampler.listDirectory ?? ((path: string) => readdirSync(path).map(String));
      const openHandles = list(`/proc/${pid}/fd`).length;
      const lsof = safeRun(sampler, "lsof", ["-nP", "-p", String(pid)]);
      return { openHandles, connections: countConnections(lsof), reason: "lsof unavailable" };
    } catch {
      return { openHandles: null, connections: null, reason: "Linux /proc or lsof unavailable" };
    }
  }
  try {
    const output = safeRun(sampler, "lsof", ["-nP", "-p", String(pid)]);
    const lines = output.split(/\r?\n/u).filter((line) => line.trim());
    return {
      openHandles: Math.max(0, lines.length - 1),
      connections: countConnections(output),
      reason: "lsof unavailable",
    };
  } catch {
    return { openHandles: null, connections: null, reason: `${platform} lsof unavailable or denied` };
  }
}

function safeRun(sampler: PackagedPerformanceSampler, command: string, args: string[]): string {
  return sampler.run ? sampler.run(command, args) : execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function safeRunOrEmpty(sampler: PackagedPerformanceSampler, command: string, args: string[]): string {
  try {
    return safeRun(sampler, command, args);
  } catch {
    return "";
  }
}

function defaultReadFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
