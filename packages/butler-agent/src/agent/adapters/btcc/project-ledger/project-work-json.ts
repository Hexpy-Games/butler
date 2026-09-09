import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function parseCanonical(body: string): Record<string, unknown> {
  if (body.length > 1_048_576) invalid();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return invalid();
  }
  if (canonicalJson(value) !== body) invalid();
  return object(value);
}

export function projectWorkRecordId(kind: string, identity: string): string {
  return `guided-${kind}-${digest(`btcc-guided-work.v1\0${kind}\0${identity}`)}`;
}

export function requestDigest(value: unknown): string {
  return digest(canonicalJson(value));
}

export function workPath(projectId: string, workId: string): string {
  safeId(workId);
  return `project-ledger/projects/${projectId}/work/${workId}/work.md`;
}

export function childPath(
  projectId: string,
  kind: "plan" | "reference",
  id: string,
): string {
  safeId(id);
  const directory = kind === "plan" ? "plans" : "references";
  return `project-ledger/projects/${projectId}/${directory}/${id.toLocaleLowerCase("en-US")}.md`;
}

export function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid();
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object")
    return invalid();
  return value as Record<string, unknown>;
}

export function textRequired(value: unknown): void {
  if (!text(value)) invalid();
}
export function textValue(value: unknown): void {
  if (typeof value !== "string" || value.length > 16384) invalid();
}
export function isoRequired(value: unknown): void {
  if (!text(value) || Number.isNaN(Date.parse(value))) invalid();
}
export function boundedArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 512) invalid();
  return value;
}
export function stringArray(value: unknown): void {
  for (const item of boundedArray(value)) textRequired(item);
}
export function positiveRevision(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid();
}
export function nonnegative(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
}
export function digestValue(value: unknown): void {
  if (!/^[a-f0-9]{64}$/u.test(String(value))) invalid();
}
export function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number" && !Number.isFinite(value)) invalid();
  if (value === undefined) invalid();
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, child]) => [key.normalize("NFC"), normalize(child)] as const,
    );
    if (
      entries.length > 512 ||
      new Set(entries.map(([key]) => key)).size !== entries.length
    )
      invalid();
    return Object.fromEntries(
      entries.sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return value;
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 4096
  );
}
function safeId(value: string): void {
  if (!text(value) || value === "." || value === ".." || /[\\/]/u.test(value))
    invalid();
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
