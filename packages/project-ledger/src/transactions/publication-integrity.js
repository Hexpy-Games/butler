import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ledgerRoot } from "../fs.js";
import { check, readIndex } from "../indexer.js";
import { observeProjectLedgerSourceHead } from "./source-head.js";

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
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim()) JSON.parse(line);
  }
}
