import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { relative } from "node:path";
import { ledgerRoot } from "../fs.js";
import { readRecordBody, readRecordData, recordFiles } from "../records.js";
import { isNonAuthoritativeProjectLedgerStorage } from "../storage-authority.js";

const NON_SEMANTIC_FIELDS = new Set([
  "createdAt", "updatedAt", "generatedAt", "sourceMtimeMs",
  "path", "codeCommits", "ledgerCommits",
]);

export function observeProjectLedgerSourceHead(project) {
  const root = ledgerRoot(project);
  const semanticRecords = recordFiles(root).map((file) => semanticRecord(root, file))
    .sort((left, right) => `${left.kind}\0${left.id}`.localeCompare(`${right.kind}\0${right.id}`));
  const logicalBytes = canonicalJson(semanticRecords);
  const entries = rootEntries(root);
  const storage = createHash("sha256");
  for (const entry of entries) {
    storage.update(entry.kind);
    storage.update("\0");
    storage.update(normalizedRelative(root, entry.path).normalize("NFC"));
    storage.update("\0");
    if (entry.kind === "file") storage.update(readFileSync(entry.path));
    storage.update("\0");
  }
  return {
    schema: "project-ledger.source-head.v1",
    storageAuthority: "project-ledger-authoritative-v2",
    projectRoot: root,
    sourceSha256: digest(logicalBytes),
    sourceFileCount: semanticRecords.length,
    storageSha256: storage.digest("hex"),
    storageEntryCount: entries.length,
  };
}

export function canonicalProjectLedgerSemantics(project) {
  const root = ledgerRoot(project);
  return canonicalJson(recordFiles(root).map((file) => semanticRecord(root, file))
    .sort((left, right) => `${left.kind}\0${left.id}`.localeCompare(`${right.kind}\0${right.id}`)));
}

function semanticRecord(root, file) {
  const data = readRecordData(file) ?? {};
  const metadata = Object.fromEntries(Object.entries(data)
    .filter(([key]) => !NON_SEMANTIC_FIELDS.has(key)));
  const relativePath = normalizedRelative(root, file);
  return normalize({
    kind: typeof data.kind === "string"
      ? data.kind
      : relativePath === "project.json" ? "project" : "record",
    id: typeof data.id === "string" ? data.id : "project",
    metadata,
    ...(file.endsWith(".md") ? { body: readRecordBody(file) ?? "" } : {}),
  });
}

function rootEntries(root) {
  const entries = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    const path = `${root}/${dirent.name}`;
    if (isNonAuthoritativeProjectLedgerStorage(path)) continue;
    if (dirent.isDirectory()) {
      entries.push({ kind: "directory", path });
      entries.push(...rootEntries(path));
    } else if (dirent.isFile()) entries.push({ kind: "file", path });
    else throw new Error(`Unsupported Project Ledger root entry: ${path}`);
  }
  return entries.sort((left, right) =>
    normalizedRelative(root, left.path).localeCompare(normalizedRelative(root, right.path)));
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Project Ledger semantic number is not finite");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${canonicalJson(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  throw new Error("Project Ledger semantic value is not JSON-compatible");
}

function normalize(value) {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key.normalize("NFC"), normalize(child)]));
  }
  return value;
}

function normalizedRelative(root, file) {
  return relative(root, file).split("\\").join("/");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
