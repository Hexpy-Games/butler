#!/usr/bin/env bun

import { runNativeButlerMain } from "../src/application/native-butler.ts";

try {
  const result = await runNativeButlerMain();
  process.stdout.write(`${result.sessionId}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
