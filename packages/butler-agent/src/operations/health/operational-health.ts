import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { configuredPageReaderBackend, type PageReaderBackendId } from "../../integrations/search/page-reader.ts";
import { readWebSearchMetrics, type WebSearchMetrics } from "../../integrations/search/provider.ts";

const SESSION_DELIVERY_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1_000;

export interface OperationalHealthSummary {
  delivery: {
    pending: number;
    failed: number;
    delivered: number;
    sessionFailed: number;
    lastError: string | null;
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

  const sessionDelivery = readSessionDeliveryFailures(join(butlerData, "transcripts"));
  summary.delivery.sessionFailed = sessionDelivery.failed;
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

function readSessionDeliveryFailures(transcriptsDir: string): { failed: number; lastError: string | null } {
  if (!existsSync(transcriptsDir)) {
    return { failed: 0, lastError: null };
  }

  const cutoffMs = Date.now() - SESSION_DELIVERY_FAILURE_WINDOW_MS;
  let failed = 0;
  let lastError: string | null = null;
  for (const entry of readdirSync(transcriptsDir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const file = join(transcriptsDir, entry);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = readJsonLine(line);
      if (event?.kind !== "delivery") continue;
      const timestamp = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : Number.NaN;
      if (Number.isFinite(timestamp) && timestamp < cutoffMs) continue;
      const payload = event.payload;
      if (!payload || typeof payload !== "object") continue;
      if ((payload as { ok?: unknown }).ok !== false) continue;
      failed += 1;
      const error = (payload as { error?: unknown }).error;
      if (typeof error === "string" && error.trim()) {
        lastError = error.trim();
      }
    }
  }
  return { failed, lastError };
}

function readJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function renderOperationalHealth(summary: OperationalHealthSummary): string {
  const lines = [
    "## Operational Reliability",
    `delivery backlog: pending=${summary.delivery.pending}, failed=${summary.delivery.failed}, delivered=${summary.delivery.delivered}`,
    `session delivery failures: failed=${summary.delivery.sessionFailed}`,
  ];
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
