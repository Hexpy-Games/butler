import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { configuredPageReaderBackend, type PageReaderBackendId } from "../../integrations/search/page-reader.ts";
import { readWebSearchMetrics, type WebSearchMetrics } from "../../integrations/search/provider.ts";
import {
  ensureTranscriptActivityAggregateStatus,
} from "../metrics/transcript-activity-index.ts";

export interface OperationalHealthSummary {
  delivery: {
    pending: number;
    failed: number;
    delivered: number;
    sessionFailed: number;
    lastError: string | null;
  };
  sessionActivity: {
    status: "available" | "degraded" | "unavailable";
    reason: string | null;
  };
  tasks: {
    running: number;
    recoverable: number;
    failed: number;
  };
  webSearch: WebSearchMetrics;
  pageReader: {
    backend: PageReaderBackendId;
  };
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

export function readOperationalHealth(butlerData: string): OperationalHealthSummary {
  const queueDir = join(butlerData, "runtime", "task-notifications");
  const summary: OperationalHealthSummary = {
    delivery: {
      pending: 0,
      failed: 0,
      delivered: 0,
      sessionFailed: 0,
      lastError: null,
    },
    sessionActivity: {
      status: "available",
      reason: null,
    },
    tasks: {
      running: 0,
      recoverable: 0,
      failed: 0,
    },
    webSearch: {
      ...readWebSearchMetrics(butlerData),
      lastQuery: null,
    },
    pageReader: {
      backend: configuredPageReaderBackend({ butlerData }),
    },
  };

  if (existsSync(queueDir)) {
    for (const entry of readdirSync(queueDir)) {
      if (!entry.endsWith(".json")) continue;
      const notification = readJson(join(queueDir, entry));
      const status = notification?.status;
      if (status === "pending") summary.delivery.pending += 1;
      else if (status === "failed") {
        summary.delivery.failed += 1;
        const lastError = notification?.lastError;
        if (typeof lastError === "string" && lastError.trim()) {
          summary.delivery.lastError = lastError.trim();
        }
      } else if (status === "delivered") {
        summary.delivery.delivered += 1;
      }
    }
  }

  const sessionDelivery = readSessionDeliveryFailures(butlerData);
  summary.delivery.sessionFailed = sessionDelivery.failed;
  summary.sessionActivity = sessionDelivery.activity;
  if (!summary.delivery.lastError && sessionDelivery.lastError) {
    summary.delivery.lastError = sessionDelivery.lastError;
  }

  const tasksDir = join(butlerData, "tasks");
  if (existsSync(tasksDir)) {
    for (const entry of readdirSync(tasksDir)) {
      const status = readText(join(tasksDir, entry, "status"));
      if (status === "RUNNING") summary.tasks.running += 1;
      else if (status === "RECOVERABLE") summary.tasks.recoverable += 1;
      else if (status === "FAILED") summary.tasks.failed += 1;
    }
  }

  return summary;
}

function readSessionDeliveryFailures(butlerData: string): {
  failed: number;
  lastError: string | null;
  activity: OperationalHealthSummary["sessionActivity"];
} {
  const activity = ensureTranscriptActivityAggregateStatus({ butlerData });
  return {
    failed: activity.summary.deliveryFailed,
    lastError: activity.summary.lastDeliveryError,
    activity: {
      status: activity.availability,
      reason: activity.reason,
    },
  };
}

export function renderOperationalHealth(summary: OperationalHealthSummary): string {
  const lines = [
    "## Operational Reliability",
    `delivery backlog: pending=${summary.delivery.pending}, failed=${summary.delivery.failed}, delivered=${summary.delivery.delivered}`,
    `session delivery failures: failed=${summary.delivery.sessionFailed}`,
  ];
  if (summary.sessionActivity.status !== "available") {
    lines.push(`session activity index: ${summary.sessionActivity.status}${summary.sessionActivity.reason ? ` (${summary.sessionActivity.reason})` : ""}`);
  }
  if (summary.delivery.lastError) {
    lines.push(`delivery last error: ${summary.delivery.lastError}`);
  }
  lines.push(
    `task recovery: running=${summary.tasks.running}, recoverable=${summary.tasks.recoverable}, failed=${summary.tasks.failed}`,
    `web search: requests=${summary.webSearch.requestCount}, provider=${summary.webSearch.lastProvider ?? "none"}`,
    `page reader: backend=${summary.pageReader.backend}`,
  );
  if (summary.webSearch.lastError) {
    lines.push(`web search last error: ${summary.webSearch.lastError}`);
  }
  return lines.join("\n");
}
