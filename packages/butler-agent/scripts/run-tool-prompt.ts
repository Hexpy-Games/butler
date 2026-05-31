#!/usr/bin/env bun

import { existsSync, readFileSync } from "fs";
import { runShellTask } from "../src/integrations/providers/provider.ts";

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

const projectPath = getArg("--project-path");
const model = getArg("--model");
const instructionsFile = getArg("--instructions-file");

if (!projectPath) {
  console.error("Usage: $BUTLER_BUN run packages/butler-agent/scripts/run-tool-prompt.ts --project-path <path> [--model <model>] [--instructions-file <file>]");
  process.exit(1);
}

let instructions: string | undefined;
if (instructionsFile) {
  if (!existsSync(instructionsFile)) {
    console.error(`Instructions file not found: ${instructionsFile}`);
    process.exit(1);
  }
  instructions = readFileSync(instructionsFile, "utf8");
}

const prompt = await Bun.stdin.text();
if (!prompt.trim()) {
  console.error("Prompt is required on stdin.");
  process.exit(1);
}

function log(line: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.error(`[tool-runner] [${ts}] ${line}`);
}

try {
  const result = await runShellTask({
    prompt,
    projectPath,
    model,
    instructions,
    log,
  });
  process.stdout.write(result);
  if (!result.endsWith("\n")) process.stdout.write("\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
