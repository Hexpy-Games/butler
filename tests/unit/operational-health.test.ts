import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readOperationalHealth, renderOperationalHealth } from "../../packages/butler-agent/src/operations/health/operational-health.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-operational-health-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("operational health summarizes delivery backlog and recoverable tasks", () => {
  const queueDir = join(tempDir, "runtime", "task-notifications");
  mkdirSync(queueDir, { recursive: true });
  writeFileSync(join(queueDir, "pending.json"), JSON.stringify({
    status: "pending",
  }), "utf8");
  writeFileSync(join(queueDir, "failed.json"), JSON.stringify({
    status: "failed",
    lastError: "Telegram Bad Request: message is too long",
  }), "utf8");
  writeFileSync(join(queueDir, "delivered.json"), JSON.stringify({
    status: "delivered",
  }), "utf8");

  const tasksDir = join(tempDir, "tasks");
  mkdirSync(join(tasksDir, "task-running"), { recursive: true });
  mkdirSync(join(tasksDir, "task-recoverable"), { recursive: true });
  mkdirSync(join(tasksDir, "task-failed"), { recursive: true });
  writeFileSync(join(tasksDir, "task-running", "status"), "RUNNING\n", "utf8");
  writeFileSync(join(tasksDir, "task-recoverable", "status"), "RECOVERABLE\n", "utf8");
  writeFileSync(join(tasksDir, "task-failed", "status"), "FAILED\n", "utf8");
  mkdirSync(join(tempDir, "runtime"), { recursive: true });
  writeFileSync(join(tempDir, "runtime", "web-search-metrics.json"), JSON.stringify({
    requestCount: 3,
    lastProvider: "duckduckgo-html",
    lastQuery: "SECRET_SEARCH_QUERY",
    lastError: null,
  }), "utf8");
  mkdirSync(join(tempDir, "transcripts"), { recursive: true });
  writeFileSync(join(tempDir, "transcripts", "butler_main.jsonl"), [
    JSON.stringify({
      kind: "delivery",
      timestamp: new Date().toISOString(),
      payload: {
        ok: false,
        error: "Bad Request: reserved character",
      },
    }),
    "",
  ].join("\n"), "utf8");

  const summary = readOperationalHealth(tempDir);

  expect(summary).toEqual({
    delivery: {
      pending: 1,
      failed: 1,
      delivered: 1,
      sessionFailed: 1,
      lastError: "Telegram Bad Request: message is too long",
    },
    tasks: {
      running: 1,
      recoverable: 1,
      failed: 1,
    },
    webSearch: {
      requestCount: 3,
      lastProvider: "duckduckgo-html",
      lastQuery: null,
      lastError: null,
    },
    pageReader: {
      backend: "lightweight",
    },
  });
  expect(renderOperationalHealth(summary)).toContain("delivery backlog: pending=1, failed=1, delivered=1");
  expect(renderOperationalHealth(summary)).toContain("session delivery failures: failed=1");
  expect(renderOperationalHealth(summary)).toContain("task recovery: running=1, recoverable=1, failed=1");
  expect(renderOperationalHealth(summary)).toContain("web search: requests=3, provider=duckduckgo-html");
  expect(renderOperationalHealth(summary)).toContain("page reader: backend=lightweight");
  expect(JSON.stringify(summary)).not.toContain("SECRET_SEARCH_QUERY");
});

test("operational health surfaces transcript delivery failure when notification queue is empty", () => {
  mkdirSync(join(tempDir, "transcripts"), { recursive: true });
  writeFileSync(join(tempDir, "transcripts", "butler_main.jsonl"), [
    JSON.stringify({
      kind: "delivery",
      timestamp: new Date().toISOString(),
      payload: {
        ok: false,
        error: "Bad Request: can't parse entities",
      },
    }),
    "",
  ].join("\n"), "utf8");

  const summary = readOperationalHealth(tempDir);

  expect(summary.delivery).toEqual({
    pending: 0,
    failed: 0,
    delivered: 0,
    sessionFailed: 1,
    lastError: "Bad Request: can't parse entities",
  });
  expect(renderOperationalHealth(summary)).toContain("session delivery failures: failed=1");
  expect(renderOperationalHealth(summary)).toContain("delivery last error: Bad Request: can't parse entities");
});
