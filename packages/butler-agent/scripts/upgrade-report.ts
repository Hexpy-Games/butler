#!/usr/bin/env bun
import { homedir } from "os";
import { join } from "path";
import { createUpgradeReport, renderUpgradeReport } from "../src/operations/install/upgrade.ts";

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

const version = process.env.BUTLER_INSTALLER_VERSION ?? "0.1.0";
const butlerHome = expandHome(process.env.BUTLER_HOME ?? join(homedir(), "butler"));
const butlerData = expandHome(process.env.BUTLER_DATA ?? join(homedir(), ".butler"));

console.log(renderUpgradeReport(createUpgradeReport({
  version,
  butlerHome,
  butlerData,
})));
