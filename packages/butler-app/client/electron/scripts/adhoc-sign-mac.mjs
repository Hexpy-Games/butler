#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const appPath = resolve(process.argv[2] ?? "dist/Butler-darwin-arm64/Butler.app");

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    env,
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

// All signing paths preserve process-role hard links before sealing the App.
const signer = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../deploy/macos/sign-and-notarize.sh");
run(signer, ["sign-app", appPath], {
  ...process.env,
  BUTLER_SIGN_IDENTITY: "-",
  BUTLER_SIGN_KEYCHAIN: "",
  BUTLER_SIGN_TEAM_ID: "",
});
run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
process.stdout.write(`macOS ad-hoc signature verified: ${appPath}\n`);
