#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

const bun = process.env.BUTLER_BUN || "bun";
const result = spawnSync(
  bun,
  ["run", "--silent", "packages/butler-agent/src/operations/release/package-service-release.ts", ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);

process.exit(result.status ?? 1);
