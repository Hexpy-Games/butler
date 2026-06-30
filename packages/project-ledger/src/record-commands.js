import { existsSync, readFileSync } from "node:fs";
import { CliError, nowIso } from "./errors.js";
import { optionalNumber, optionalString, requiredOption } from "./args.js";
import { appendLedgerEvent, projectPath, projectRelative } from "./fs.js";
import {
  readRecord,
  readRecordBody,
  recordFiles,
  topLevelRecordPath,
  updateMarkdownRecord,
  writeMarkdownRecord,
} from "./records.js";
import { gitCommitEvidence } from "./git-evidence.js";
import { assertTransition, completionGateIssues } from "./state-machine.js";

export const TOP_LEVEL_RECORD_KINDS = new Set([
  "initiative",
  "decision",
  "risk",
  "spec",
  "report",
  "plan",
  "handoff",
  "reference",
  "roadmap",
]);

export const SOURCE_RECORD_KINDS = new Set([
  ...TOP_LEVEL_RECORD_KINDS,
  "work",
  "task",
  "attempt",
]);

const DEFAULT_STATUS_BY_KIND = {
  decision: "accepted",
  risk: "open",
  report: "done",
  plan: "active",
};

const METADATA_FIELDS = [
  "title",
  "status",
  "spec",
  "parentId",
  "validation",
  "review",
  "report",
  "implementation",
  "mitigation",
  "reason",
  "acceptance",
  "codeCommits",
  "ledgerCommits",
];

export function optionUpdates(options, fields = METADATA_FIELDS) {
  const updates = {};
  for (const field of fields) {
    const value = optionalString(options, field);
    if (value !== null) updates[field] = value;
  }
  const codeCommits = optionalString(options, "code-commits");
  if (codeCommits !== null) updates.codeCommits = codeCommits;
  const ledgerCommits = optionalString(options, "ledger-commits");
  if (ledgerCommits !== null) updates.ledgerCommits = ledgerCommits;
  if (optionalString(options, "code-commit") === "auto") {
    updates.codeCommits = JSON.stringify([gitCommitEvidence(options.project ? String(options.project) : process.cwd())]);
  }
  if (options["spec-exemption"]) updates.specExemption = true;
  if (options["acceptance-exemption"]) updates.acceptanceExemption = true;
  if (options["requires-commit-evidence"]) updates.requiresCommitEvidence = true;
  const priority = optionalNumber(options, "priority");
  if (priority !== null) updates.priority = priority;
  return updates;
}

export function readBodyInput(options) {
  const from = optionalString(options, "from");
  const literalBody = typeof options.body === "string" ? options.body : null;
  if (from !== null && literalBody !== null) {
    throw new CliError("--from and --body cannot be used together", "invalid_input", 1);
  }
  if (literalBody !== null) {
    if (!literalBody.trim()) throw new CliError("--body input is empty", "invalid_input", 1);
    return literalBody;
  }
  if (from === null) return undefined;
  const body = from === "-" ? readFileSync(0, "utf8") : readFileSync(from, "utf8");
  if (!body.trim()) throw new CliError("--from input is empty", "invalid_input", 1);
  return body;
}

export function modeledRecordKind(kind) {
  if (!TOP_LEVEL_RECORD_KINDS.has(kind)) {
    throw new CliError(`Unsupported record kind: ${kind}`, "invalid_input", 1);
  }
  return kind;
}

function defaultStatus(kind, options) {
  return optionalString(options, "status") ?? DEFAULT_STATUS_BY_KIND[kind] ?? "active";
}

function baseRecord(kind, options) {
  const timestamp = nowIso();
  return {
    schema: `project-ledger.${kind}.v1`,
    kind,
    id: requiredOption(options, "id"),
    title: requiredOption(options, "title"),
    status: defaultStatus(kind, options),
    createdAt: timestamp,
    updatedAt: timestamp,
    ...optionUpdates(options),
  };
}

function recordsMatching(project, id, kind = null) {
  return recordFiles(project)
    .map((filePath) => ({ filePath, record: readRecord(project, filePath) }))
    .filter(({ record }) => record && record.id === id && (kind === null || record.kind === kind));
}

function recordNotFoundNext(kind, id) {
  const scope = kind ?? "all";
  return [
    {
      command: kind ? `project-ledger record show --kind ${kind} --id ${id}` : `project-ledger record show --id ${id}`,
      reason: "Check the exact id and kind.",
    },
    {
      command: `project-ledger query --kind ${scope}`,
      reason: "List existing records before retrying.",
    },
  ];
}

function ambiguousRecordNext(id, matches) {
  return matches.map(({ record }) => ({
    command: `project-ledger record show --kind ${record.kind} --id ${id}`,
    reason: `Retry with --kind ${record.kind}.`,
  }));
}

export function resolveRecord(project, options) {
  const id = requiredOption(options, "id");
  const kind = optionalString(options, "kind");
  const matches = recordsMatching(project, id, kind);
  if (matches.length === 0) {
    throw new CliError(
      `${kind ? `${kind} ` : ""}record not found: ${id}`,
      "record_not_found",
      1,
      [{ id, kind }],
      recordNotFoundNext(kind, id),
    );
  }
  if (matches.length > 1) {
    throw new CliError(
      `Record id is ambiguous: ${id}`,
      "ambiguous_record",
      1,
      matches.map(({ record }) => ({
        id: record.id,
        kind: record.kind,
        path: record.path,
      })),
      ambiguousRecordNext(id, matches),
    );
  }
  return matches[0];
}

export function writeAndReturn(project, filePath, data, body = null, eventType = null) {
  writeMarkdownRecord(filePath, data, body);
  const record = readRecord(project, filePath);
  appendLedgerEvent(project, {
    type: eventType ?? `${data.kind}_written`,
    id: data.id,
    kind: data.kind,
    status: data.status,
    path: projectRelative(project, filePath),
    source: "project-ledger",
  });
  return record;
}

export function createRecord(project, options) {
  const kind = modeledRecordKind(requiredOption(options, "kind"));
  const data = baseRecord(kind, options);
  const filePath = topLevelRecordPath(project, kind, data.id);
  if (existsSync(filePath)) throw new CliError(`${kind} already exists: ${data.id}`, "record_exists", 1);
  return writeAndReturn(project, filePath, data, readBodyInput(options), `${kind}_created`);
}

export function showRecord(project, options) {
  const { filePath, record } = resolveRecord(project, options);
  if (!options.body) return record;
  return {
    ...record,
    body: readRecordBody(projectPath(project, record.path)) ?? readRecordBody(filePath),
  };
}

export function updateRecord(project, options) {
  const { filePath, record } = resolveRecord(project, options);
  if (!SOURCE_RECORD_KINDS.has(record.kind)) {
    throw new CliError(`Record kind does not support generic update: ${record.kind}`, "invalid_input", 1);
  }
  const updates = optionUpdates(options);
  const body = readBodyInput(options);
  if (Object.keys(updates).length === 0 && body === undefined) {
    throw new CliError("record update requires --from or at least one metadata flag", "invalid_input", 1);
  }
  if (updates.status && ["work", "task", "attempt"].includes(record.kind)) {
    assertTransition(record.kind, record.status, updates.status, { id: record.id, taskId: record.parentId });
    if (record.kind === "work" && updates.status === "done") {
      const candidate = {
        ...record,
        ...updates,
        specExemption: updates.specExemption ?? record.specExemption,
        acceptanceExemption: updates.acceptanceExemption ?? record.acceptanceExemption,
      };
      const gaps = completionGateIssues(candidate);
      if (gaps.length > 0) {
        throw new CliError(
          `Work completion gate failed: ${gaps.map((gap) => gap.field).join(", ")}`,
          "completion_gate_failed",
          1,
          gaps,
          gaps.flatMap((gap) => gap.next ?? []),
        );
      }
    }
  }
  updateMarkdownRecord(filePath, updates, body);
  appendLedgerEvent(project, {
    type: `${record.kind}_updated`,
    id: record.id,
    kind: record.kind,
    path: projectRelative(project, filePath),
    source: "project-ledger",
  });
  return readRecord(project, filePath);
}
