#!/usr/bin/env bun
import { homedir } from "os";
import { join } from "path";
import { readContextMonitor } from "../src/operations/metrics/context-monitor.ts";
import { readOperationalHealth } from "../src/operations/health/operational-health.ts";
import { readUsageMonitor } from "../src/operations/metrics/usage-monitor.ts";
import {
  isOperationalMetricsEnabled,
  readOperationalMetricSummary,
  setOperationalMetricsEnabled,
  tailOperationalMetricEvents,
} from "../src/operations/metrics/operational-metrics.ts";
import { readFirstVisibleLatencySummary } from "../src/operations/metrics/first-visible-latency.ts";

interface ParsedArgs {
  command: "status" | "tail" | "enable" | "disable";
  json: boolean;
  butlerData: string;
  sinceHours: number | null;
  lines: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const command = (args.shift() ?? "status") as ParsedArgs["command"];
  let json = false;
  let butlerData = process.env.BUTLER_DATA || join(homedir(), ".butler");
  let sinceHours: number | null = null;
  let lines = 20;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--data") {
      butlerData = args[++i] ?? butlerData;
    } else if (arg === "--since-hours") {
      const parsed = Number(args[++i]);
      sinceHours = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    } else if (arg === "--lines") {
      const parsed = Number(args[++i]);
      lines = Number.isFinite(parsed) && parsed > 0 ? parsed : lines;
    }
  }

  if (!["status", "tail", "enable", "disable"].includes(command)) {
    throw new Error(`unknown metrics command: ${command}`);
  }

  return {
    command,
    json,
    butlerData,
    sinceHours,
    lines,
  };
}

function sinceTs(hours: number | null | undefined): number | undefined {
  return typeof hours === "number" ? Date.now() - hours * 60 * 60 * 1000 : undefined;
}

export function buildMetricsStatus(input: {
  butlerData: string;
  sinceHours?: number | null;
}) {
  const since = sinceTs(input.sinceHours);
  return {
    enabled: isOperationalMetricsEnabled({ butlerData: input.butlerData }),
    operational: readOperationalMetricSummary({
      butlerData: input.butlerData,
      sinceTs: since,
    }),
    firstVisibleLatency: readFirstVisibleLatencySummary({
      butlerData: input.butlerData,
      sinceTs: since,
    }),
    usage: readUsageMonitor({
      butlerData: input.butlerData,
      sinceTs: since ?? null,
    }),
    context: readContextMonitor({
      butlerData: input.butlerData,
    }),
    health: readOperationalHealth(input.butlerData),
  };
}

function buildStatus(input: ParsedArgs) {
  return buildMetricsStatus(input);
}

export function renderMetricsStatus(status: ReturnType<typeof buildMetricsStatus>): string {
  const operational = status.operational;
  const runtimeBucket = operational.byCategory.runtime;
  const toolBucket = operational.byCategory.tool;
  const ingressBucket = operational.byCategory.ingress;
  const firstVisible = status.firstVisibleLatency;
  return [
    "Butler metrics",
    `enabled: ${status.enabled}`,
    `operational events: ${operational.totalEvents}`,
    `parse errors: ${operational.parseErrors}`,
    `latest event: ${operational.latestEventTs ? new Date(operational.latestEventTs).toISOString() : "none"}`,
    `ingress: ${ingressBucket?.events ?? 0} events, ${ingressBucket?.errors ?? 0} errors`,
    `runtime: ${runtimeBucket?.events ?? 0} events, ${runtimeBucket?.errors ?? 0} errors`,
    `tools: ${toolBucket?.events ?? 0} events, ${toolBucket?.errors ?? 0} errors`,
    `first visible latency: events=${firstVisible.events}, p50=${firstVisible.p50Ms ?? "none"}ms, p95=${firstVisible.p95Ms ?? "none"}ms`,
    `prompt cache: requests=${status.usage.model.requestCount}, cached=${status.usage.model.cachedTokens}, hitRatio=${status.usage.model.cacheHitRatio.toFixed(3)}`,
    `web search: requests=${status.usage.webSearch.requestCount}, provider=${status.usage.webSearch.lastProvider ?? "none"}, lastError=${status.usage.webSearch.lastError ?? "none"}`,
    `context pressure: ${status.context.pressure.thresholdState}, usedRatio=${(status.context.pressure.usedRatio * 100).toFixed(1)}%`,
    `privacy: rawTextStored=${operational.privacy.rawTextStored}`,
  ].join("\n");
}

function renderTail(input: ParsedArgs): string {
  const events = tailOperationalMetricEvents({
    butlerData: input.butlerData,
    sinceTs: sinceTs(input.sinceHours),
    lines: input.lines,
  });
  if (input.json) return `${JSON.stringify(events, null, 2)}\n`;
  if (!events.length) return "No operational metrics found.\n";
  return `${events.map((event) => [
    new Date(event.ts).toISOString(),
    event.category,
    event.name,
    event.status,
    typeof event.durationMs === "number" ? `${event.durationMs}ms` : "",
  ].filter(Boolean).join("  ")).join("\n")}\n`;
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    if (args.command === "enable" || args.command === "disable") {
      const enabled = args.command === "enable";
      setOperationalMetricsEnabled({
        butlerData: args.butlerData,
        enabled,
      });
      const payload = {
        enabled,
        configPath: join(args.butlerData, "butler.config.json"),
      };
      if (args.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Butler metrics ${enabled ? "enabled" : "disabled"}.`);
      }
    } else if (args.command === "tail") {
      process.stdout.write(renderTail(args));
    } else {
      const status = buildStatus(args);
      if (args.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log(renderMetricsStatus(status));
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
