import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { ledgerRoot } from "../fs.js";
import { check, readIndex } from "../indexer.js";
import { observeProjectLedgerSourceHead } from "./source-head.js";

const EVENT_LOG_READ_BUFFER_BYTES = 64 * 1024;
const MAX_EVENT_LOG_LINE_BYTES = 4 * 1024 * 1024;

export function inspectPublicationRoot(project) {
  const root = ledgerRoot(project);
  assertEventLogReadable(join(root, "ledger.jsonl"));
  const index = readIndex(root);
  if (!index?.index?.available || index.index.stale) {
    throw new Error("Project Ledger publication index is missing or stale");
  }
  const validation = check(root);
  const errors = validation.issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    const issue = errors[0];
    throw new Error([
      `Project Ledger publication check failed: ${issue.code}`,
      issue.message,
      issue.path,
    ].filter(Boolean).join(": "));
  }
  return observeProjectLedgerSourceHead(root);
}

export function assertExchangeCompatible(left, right) {
  if (statSync(left).dev !== statSync(right).dev) {
    throw new Error("Project Ledger roots must share a filesystem for atomic exchange");
  }
}

function assertEventLogReadable(path) {
  const fileDescriptor = openSync(path, "r");
  const readBuffer = Buffer.alloc(EVENT_LOG_READ_BUFFER_BYTES);
  const lineParts = [];
  let lineBytes = 0;

  const appendLinePart = (part) => {
    if (part.length === 0) return;
    lineBytes += part.length;
    if (lineBytes > MAX_EVENT_LOG_LINE_BYTES) {
      throw new ProjectLedgerEventLogLineTooLargeError();
    }
    lineParts.push(Buffer.from(part));
  };

  const validateLine = () => {
    const line = Buffer.concat(lineParts).toString("utf8");
    if (line.trim()) JSON.parse(line);
    lineParts.length = 0;
    lineBytes = 0;
  };

  const consumeBytes = (bytes) => {
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start);
      if (newline < 0) {
        appendLinePart(bytes.subarray(start));
        return;
      }
      appendLinePart(bytes.subarray(start, newline));
      validateLine();
      start = newline + 1;
    }
  };

  try {
    let bytesRead;
    do {
      bytesRead = readSync(fileDescriptor, readBuffer, 0, readBuffer.length, null);
      if (bytesRead > 0) consumeBytes(readBuffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    if (lineParts.length > 0) validateLine();
  } finally {
    closeSync(fileDescriptor);
  }
}

export class ProjectLedgerEventLogLineTooLargeError extends Error {
  constructor() {
    super("Project Ledger event log line exceeds the bounded validation limit");
    this.name = "ProjectLedgerEventLogLineTooLargeError";
    this.code = "project_ledger_event_line_too_large";
  }
}
