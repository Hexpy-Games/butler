#!/usr/bin/env bun
import { resolve } from "node:path";
import { runM1V2BaselineCampaign } from "./runner.ts";

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
}

function usage(): string {
  return [
    "M1 v2 segment-attribution baseline campaign",
    "  --output-root DIR --source-data DIR [--repetitions 3]",
    "  [--source-revision SHA] [--browser-executable FILE]",
    "",
    "Runs the four canonical public fixtures sequentially through the real",
    "Electron -> App -> BTCC -> provider path. Every repetition gets a fresh",
    "run root and SQLite state. The privacy-safe campaign.json never contains",
    "prompt/final text, URLs, queries, private paths, credentials, or raw tool data.",
  ].join("\n");
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }
  const outputRoot = option(argv, "--output-root");
  const sourceData = option(argv, "--source-data");
  const sourceRevision = option(argv, "--source-revision");
  if (!outputRoot || !sourceData || !sourceRevision) throw new Error(usage());
  const repetitions = Number(option(argv, "--repetitions") ?? "3");
  const result = await runM1V2BaselineCampaign({
    outputRoot: resolve(outputRoot),
    sourceData: resolve(sourceData),
    repoRoot: process.cwd(),
    repetitions,
    sourceRevision,
    browserExecutablePath: option(argv, "--browser-executable"),
  });
  console.log(JSON.stringify({
    complete: result.complete,
    counts: result.counts,
    repetitions: result.repetitions.length,
  }, null, 2));
  if (!result.complete) process.exitCode = 1;
}

await main(process.argv.slice(2));
