#!/usr/bin/env bun

import { existsSync, readFileSync } from "fs";
import { runPromptText } from "../src/integrations/providers/provider.ts";

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

const model = getArg("--model");
const instructionsFile = getArg("--instructions-file");

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

try {
  const result = await runPromptText({
    prompt,
    model,
    instructions,
  });
  process.stdout.write(result);
  if (!result.endsWith("\n")) process.stdout.write("\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
