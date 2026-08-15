import { readFileSync, writeFileSync } from "node:fs";
import {
  capturePackagedPerformanceSnapshot,
  PACKAGED_PHYSICAL_PROCESS_ROLES,
  type PackagedProcessRole,
  type PackagedPerformanceSnapshot,
  type PackagedProcessTarget,
} from "./packaged-performance-snapshot.ts";
import {
  evaluatePhysicalMemoryGate,
  type EmbedIdleReclamation,
} from "./physical-memory-gate.ts";
import {
  collectElectronForwardProgressBenchmark,
  type ElectronForwardProgressBenchmarkInput,
} from "./turn-forward-progress-electron-benchmark.ts";

type ReportInput = Omit<ElectronForwardProgressBenchmarkInput, "afterSnapshot"> & {
  processTargets: PackagedProcessTarget[];
  cycleSnapshots?: PackagedPerformanceSnapshot[];
  idleReclamation?: EmbedIdleReclamation;
  requiredProcessRoles?: PackagedProcessRole[];
};

export function runPackagedPerformanceReportCli(argv: string[]): string {
  const command = argv[0];
  if (command === "snapshot") return runSnapshot(argv.slice(1));
  if (command === "report") return runReport(argv.slice(1));
  return usage();
}

function runSnapshot(argv: string[]): string {
  const butlerData = requiredOption(argv, "--butler-data");
  const processTargets = repeatedOptions(argv, "--process").map(parseProcessTarget);
  assertAllRoles(processTargets, hasFlag(argv, "--require-full-roles"));
  const cycleIndexText = option(argv, "--cycle-index");
  const phase = option(argv, "--phase");
  const cycle = cycleIndexText === undefined
    ? undefined
    : {
        index: parseCycleIndex(cycleIndexText),
        phase: parseCyclePhase(phase),
        ...(option(argv, "--label") ? { label: option(argv, "--label") } : {}),
      };
  const output = JSON.stringify(
    capturePackagedPerformanceSnapshot({ butlerData, processTargets, cycle }),
    null,
    2,
  );
  return emit(output, option(argv, "--output"));
}

function runReport(argv: string[]): string {
  const inputPath = requiredOption(argv, "--input");
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as ReportInput;
  assertAllRoles(input.processTargets, Boolean(input.requiredProcessRoles), input.requiredProcessRoles);
  const afterSnapshot = capturePackagedPerformanceSnapshot({
    butlerData: input.butlerData,
    processTargets: input.processTargets,
  });
  const { processTargets: _processTargets, cycleSnapshots, idleReclamation, requiredProcessRoles, ...benchmarkInput } = input;
  const report = collectElectronForwardProgressBenchmark({
    ...benchmarkInput,
    afterSnapshot,
  });
  const requiredRoles = requiredProcessRoles ?? PACKAGED_PHYSICAL_PROCESS_ROLES;
  const missingRoles = requiredRoles.filter((role) => !input.processTargets.some((target) => target.role === role));
  const cycles = [...(cycleSnapshots ?? [input.beforeSnapshot]), afterSnapshot];
  const physicalGate = evaluatePhysicalMemoryGate({ cycles, idleReclamation });
  if (missingRoles.length > 0) {
    physicalGate.failures.push(`missing declared process role(s): ${missingRoles.join(", ")}`);
    physicalGate.ok = false;
  }
  const extendedReport = {
    ...report,
    physicalGate,
    physicalMemory: {
      requiredRoles,
      observedRoles: [...new Set(input.processTargets.map((target) => target.role))],
      missingRoles,
      cycles: cycles.map((snapshot) => ({
        capturedAt: snapshot.capturedAt,
        cycle: snapshot.cycle ?? null,
        aggregate: snapshot.aggregate,
        system: snapshot.system,
      })),
      idleReclamation: idleReclamation ?? null,
    },
  };
  return emit(JSON.stringify(extendedReport, null, 2), option(argv, "--output"));
}

function parseProcessTarget(value: string): PackagedProcessTarget {
  const [role, pidText, ...labelParts] = value.split(":");
  if (!isProcessRole(role)) {
    throw new Error(`Unknown packaged process role: ${role ?? ""}`);
  }
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid packaged process pid: ${pidText ?? ""}`);
  }
  const label = labelParts.join(":").trim();
  return label ? { role, pid, label } : { role, pid };
}

function assertAllRoles(
  targets: PackagedProcessTarget[],
  requireFullRoles: boolean,
  declaredRoles?: PackagedProcessRole[],
): void {
  const roles = new Set(targets.map((target) => target.role));
  const requiredRoles = declaredRoles ?? (requireFullRoles ? PACKAGED_PHYSICAL_PROCESS_ROLES : CORE_PROCESS_ROLES);
  for (const role of requiredRoles) {
    if (!roles.has(role)) {
      throw new Error(`Missing required packaged process role: ${role}`);
    }
  }
}

function isProcessRole(value: string | undefined): value is PackagedProcessRole {
  return PROCESS_ROLES.includes(value as PackagedProcessRole);
}

function repeatedOptions(argv: string[], name: string): string[] {
  return argv.flatMap((value, index) =>
    value === name && argv[index + 1] ? [argv[index + 1]!] : [],
  );
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function requiredOption(argv: string[], name: string): string {
  const value = option(argv, name);
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseCycleIndex(value: string): number {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`Invalid cycle index: ${value}`);
  return index;
}

function parseCyclePhase(value: string | undefined): "warmup" | "steady" | "idle" {
  if (value === "warmup" || value === "steady" || value === "idle") return value;
  if (value !== undefined) throw new Error(`Invalid cycle phase: ${value}`);
  return "steady";
}

function emit(output: string, path?: string): string {
  if (path && path !== "-") writeFileSync(path, `${output}\n`, "utf8");
  return output;
}

function usage(): string {
  return [
    "Usage:",
    "  packaged-performance-report snapshot --butler-data PATH",
    "    --process electron_main:PID --process electron_renderer:PID",
    "    --process agent_runtime:PID [--process ROLE:PID[:LABEL]]",
    "    [--cycle-index N --phase warmup|steady|idle] [--require-full-roles] [--output FILE]",
    "  packaged-performance-report report --input MANIFEST [--output FILE]",
  ].join("\n");
}

const CORE_PROCESS_ROLES: PackagedProcessRole[] = [
  "electron_main",
  "electron_renderer",
  "agent_runtime",
];
const PROCESS_ROLES: PackagedProcessRole[] = PACKAGED_PHYSICAL_PROCESS_ROLES;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const output = runPackagedPerformanceReportCli(argv);
  const outputPath = option(argv, "--output");
  if (!outputPath || outputPath === "-") console.log(output);
}
