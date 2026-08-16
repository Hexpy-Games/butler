#!/usr/bin/env bun
import { recordSystemEvent } from "../src/test-support/harness/durable-session-transcript.ts";

function usage(): never {
  console.error(
    "Usage:\n" +
      "  $BUTLER_BUN run packages/butler-agent/scripts/session-transcript.ts system-from-env <session_id>\n",
  );
  process.exit(1);
}

const [, , command, ...rest] = process.argv;
if (!command) usage();

if (command === "system-from-env") {
  const [sessionId] = rest;
  if (!sessionId) usage();

  const category = process.env.BUTLER_SYSTEM_EVENT_CATEGORY?.trim();
  if (!category) {
    console.error("BUTLER_SYSTEM_EVENT_CATEGORY is required");
    process.exit(2);
  }

  const statusCodeRaw = process.env.BUTLER_SYSTEM_EVENT_STATUS_CODE?.trim();
  const statusCode = statusCodeRaw ? Number.parseInt(statusCodeRaw, 10) : undefined;
  const details: Record<string, unknown> = {};

  if (process.env.BUTLER_SYSTEM_EVENT_REASON?.trim()) {
    details.reason = process.env.BUTLER_SYSTEM_EVENT_REASON.trim();
  }
  if (process.env.BUTLER_SYSTEM_EVENT_STOP_REASON?.trim()) {
    details.stopReason = process.env.BUTLER_SYSTEM_EVENT_STOP_REASON.trim();
  }
  if (process.env.BUTLER_SYSTEM_EVENT_EXIT_CODE?.trim()) {
    const exitCode = Number.parseInt(process.env.BUTLER_SYSTEM_EVENT_EXIT_CODE.trim(), 10);
    details.exitCode = Number.isNaN(exitCode) ? process.env.BUTLER_SYSTEM_EVENT_EXIT_CODE.trim() : exitCode;
  }

  recordSystemEvent({
    sessionId,
    category,
    message: process.env.BUTLER_SYSTEM_EVENT_MESSAGE?.trim() || undefined,
    statusCode: Number.isNaN(statusCode) ? undefined : statusCode,
    details: Object.keys(details).length > 0 ? details : undefined,
    metadata: process.env.BUTLER_SYSTEM_EVENT_SOURCE?.trim()
      ? { source: process.env.BUTLER_SYSTEM_EVENT_SOURCE.trim() }
      : undefined,
    timestamp: process.env.BUTLER_SYSTEM_EVENT_TIMESTAMP?.trim() || undefined,
  });
  console.log(sessionId);
  process.exit(0);
}

usage();
