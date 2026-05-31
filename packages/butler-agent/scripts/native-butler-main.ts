#!/usr/bin/env bun

import { runNativeButlerMain } from "../src/interfaces/gateway/native-butler-bootstrap.ts";

try {
  const result = await runNativeButlerMain();
  process.stdout.write(`${result.sessionId}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
