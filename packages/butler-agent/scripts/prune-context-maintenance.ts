#!/usr/bin/env bun
import { homedir } from "os";
import { join } from "path";
import { pruneContextMetricFiles } from "../src/agent/context/metrics-retention.ts";
import { pruneToolOutputArtifacts } from "../src/agent/context/tool-output-budgeter.ts";

function numberArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return fallback;
  const parsed = Number(arg.slice(prefix.length));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const butlerData = process.env.BUTLER_DATA || join(homedir(), ".butler");
const dayMs = 24 * 60 * 60 * 1000;
const artifactDays = numberArg("artifact-days", 30);
const metricDays = numberArg("metric-days", 90);
const maxBytes = numberArg("artifact-max-bytes", 512 * 1024 * 1024);

const artifactResult = pruneToolOutputArtifacts({
  butlerData,
  maxAgeMs: Math.max(0, artifactDays) * dayMs,
  maxBytes: Math.max(0, maxBytes),
  recordTelemetry: true,
});
const metricResult = pruneContextMetricFiles({
  butlerData,
  maxAgeMs: Math.max(0, metricDays) * dayMs,
});

const output = {
  ok: true,
  butlerData,
  artifacts: artifactResult,
  metrics: metricResult.totals,
  privacy: {
    rawTextStored: false,
  },
};

if (flag("json")) {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} else {
  process.stdout.write([
    "Context maintenance prune complete.",
    `Artifacts: scanned=${artifactResult.scanned}, deleted=${artifactResult.deleted}, bytesDeleted=${artifactResult.bytesDeleted}, remainingBytes=${artifactResult.remainingBytes}`,
    `Metrics: scanned=${metricResult.totals.scanned}, kept=${metricResult.totals.kept}, deleted=${metricResult.totals.deleted}, parseErrors=${metricResult.totals.parseErrors}`,
    "Privacy: rawTextStored=false",
  ].join("\n"));
  process.stdout.write("\n");
}
