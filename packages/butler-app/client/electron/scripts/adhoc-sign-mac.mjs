#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const appPath = resolve(process.argv[2] ?? "dist/Butler-darwin-arm64/Butler.app");

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
}

if (process.platform !== "darwin") {
  process.stdout.write("macOS ad-hoc signing skipped on non-darwin host\n");
  process.exit(0);
}

if (!existsSync(appPath)) {
  throw new Error(`app bundle not found: ${appPath}`);
}

run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
process.stdout.write(`macOS ad-hoc signature verified: ${appPath}\n`);
