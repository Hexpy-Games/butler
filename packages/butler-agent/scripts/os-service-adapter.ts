#!/usr/bin/env bun
import { homedir } from "os";
import { join } from "path";
import { createOsServicePreview, type OsServicePlatform } from "../src/operations/service/os-service-adapter.ts";

function hasFlag(name: string): boolean {
  return Bun.argv.includes(name);
}

function platformFromCommand(command: string | undefined): OsServicePlatform {
  if (command === "launchd-plist") return "launchd";
  if (command === "systemd-unit") return "systemd";
  throw new Error(`unknown OS service adapter command: ${command ?? ""}`);
}

const command = Bun.argv[2];
const platform = platformFromCommand(command);
const butlerHome = process.env.BUTLER_HOME || join(homedir(), "butler");
const butlerData = process.env.BUTLER_DATA || join(homedir(), ".butler");
const preview = createOsServicePreview({ platform, butlerHome, butlerData });

if (hasFlag("--json")) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: `butler service ${command}`,
    data: preview,
    error: null,
    privacy: {
      rawTextIncluded: false,
      secretsIncluded: false,
    },
  }, null, 2)}\n`);
} else {
  process.stdout.write(preview.body);
}

