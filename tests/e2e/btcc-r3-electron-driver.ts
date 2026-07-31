#!/usr/bin/env bun
import {
  BTCC_R3_ELECTRON_SCENARIO_SCHEMA,
  readElectronScenario,
  runBtccR3ElectronHarness,
  type ElectronHarnessOptions,
  type ElectronScenario,
} from "./btcc-r3-electron-harness.ts";

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function usage(): string {
  return [
    "BTCC R3 real Electron E2E driver",
    "  --scenario FILE [--run-root DIR] [--source-data DIR]",
    "                  [--model provider/model] [--reasoning low]",
    "                  [--access-mode full_access] [--keep-logs]",
    "  --smoke [--run-root DIR] [--source-data DIR]",
    "  --dry-run --scenario FILE [same path/model options]",
    "",
    "The driver always creates fresh isolated Butler data, Electron profile,",
    "and workspace directories. It never writes to --source-data.",
  ].join("\n");
}

async function main(argv: string[]): Promise<void> {
  if (flag(argv, "--help") || flag(argv, "-h")) {
    console.log(usage());
    return;
  }
  const smoke = flag(argv, "--smoke");
  const scenarioPath = option(argv, "--scenario");
  if (!smoke && !scenarioPath) throw new Error(`${usage()}\n\n--scenario is required.`);
  const scenario: ElectronScenario = scenarioPath
    ? readElectronScenario(scenarioPath)
    : {
      schema: BTCC_R3_ELECTRON_SCENARIO_SCHEMA,
      id: "launch-smoke",
      session: { title: "BTCC R3 Electron launch smoke" },
      steps: [],
    };
  const options: ElectronHarnessOptions = {
    accessMode: option(argv, "--access-mode") as ElectronHarnessOptions["accessMode"],
    dryRun: flag(argv, "--dry-run"),
    keepLogs: flag(argv, "--keep-logs"),
    model: option(argv, "--model"),
    reasoningEffort: option(argv, "--reasoning") as ElectronHarnessOptions["reasoningEffort"],
    repoRoot: option(argv, "--repo-root"),
    runRoot: option(argv, "--run-root"),
    smoke,
    sourceData: option(argv, "--source-data"),
  };
  const result = await runBtccR3ElectronHarness(scenario, options);
  console.log(JSON.stringify(result, null, 2));
  if (result.ok !== true) process.exitCode = 1;
}

await main(process.argv.slice(2));
