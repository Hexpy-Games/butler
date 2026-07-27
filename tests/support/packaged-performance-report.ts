import { readFileSync, writeFileSync } from "node:fs";
import {
  capturePackagedPerformanceSnapshot,
  type PackagedProcessRole,
  type PackagedProcessTarget,
} from "./packaged-performance-snapshot.ts";
import {
  collectElectronForwardProgressBenchmark,
  type ElectronForwardProgressBenchmarkInput,
} from "./turn-forward-progress-electron-benchmark.ts";

type ReportInput = Omit<ElectronForwardProgressBenchmarkInput, "afterSnapshot"> & {
  processTargets: PackagedProcessTarget[];
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
  assertAllRoles(processTargets);
  const output = JSON.stringify(
    capturePackagedPerformanceSnapshot({ butlerData, processTargets }),
    null,
    2,
  );
  return emit(output, option(argv, "--output"));
}

function runReport(argv: string[]): string {
  const inputPath = requiredOption(argv, "--input");
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as ReportInput;
  assertAllRoles(input.processTargets);
  const afterSnapshot = capturePackagedPerformanceSnapshot({
    butlerData: input.butlerData,
    processTargets: input.processTargets,
  });
  const { processTargets: _processTargets, ...benchmarkInput } = input;
  const report = collectElectronForwardProgressBenchmark({
    ...benchmarkInput,
    afterSnapshot,
  });
  return emit(JSON.stringify(report, null, 2), option(argv, "--output"));
}

function parseProcessTarget(value: string): PackagedProcessTarget {
  const [role, pidText] = value.split(":");
  if (!isProcessRole(role)) {
    throw new Error(`Unknown packaged process role: ${role ?? ""}`);
  }
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid packaged process pid: ${pidText ?? ""}`);
  }
  return { role, pid };
}

function assertAllRoles(targets: PackagedProcessTarget[]): void {
  const roles = new Set(targets.map((target) => target.role));
  for (const role of PROCESS_ROLES) {
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

function requiredOption(argv: string[], name: string): string {
  const value = option(argv, name);
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function emit(output: string, path?: string): string {
  if (path) writeFileSync(path, `${output}\n`, "utf8");
  return output;
}

function usage(): string {
  return [
    "Usage:",
    "  packaged-performance-report snapshot --butler-data PATH",
    "    --process electron_main:PID --process electron_renderer:PID",
    "    --process agent_runtime:PID [--output FILE]",
    "  packaged-performance-report report --input MANIFEST [--output FILE]",
  ].join("\n");
}

const PROCESS_ROLES: PackagedProcessRole[] = [
  "electron_main",
  "electron_renderer",
  "agent_runtime",
];

if (import.meta.main) {
  const output = runPackagedPerformanceReportCli(process.argv.slice(2));
  if (!option(process.argv.slice(2), "--output")) console.log(output);
}
