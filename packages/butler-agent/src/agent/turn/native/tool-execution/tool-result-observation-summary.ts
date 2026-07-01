import { safeOptionalPublicText } from "../../../output/evidence/transcript-sanitizers.ts";

const SUMMARY_OUTPUT_LIMIT = 2_000;
const MAX_ERROR_DETAILS = 8;
const MAX_NEXT_HINTS = 8;
const MAX_ARG_FIELDS = 8;
const REDACTED_PATH = "[redacted-path]";
const REDACTED_VALUE = "[redacted]";
const STRING_RESULT_FIELDS = ["stderr", "stdout", "error", "message", "validation"] as const;
const ERROR_DETAIL_FIELDS = ["code", "field", "message", "id", "kind", "status"] as const;

export function summarizedToolResultForObservation(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  const record = result as Record<string, unknown>;
  const lines: string[] = [];
  const exitCode = record.exit_code;
  if (typeof exitCode === "number") lines.push(`exit_code: ${exitCode}`);
  for (const field of STRING_RESULT_FIELDS) {
    const value = record[field];
    if (typeof value === "string") {
      pushSafeLine(lines, field, value);
    } else if (field === "error" && isPlainRecord(value)) {
      appendStructuredError(lines, value);
    }
  }
  return limitSummary(lines.join("\n"));
}

function appendStructuredError(lines: string[], error: Record<string, unknown>): void {
  pushSafeLine(lines, "error.code", error.code);
  pushSafeLine(lines, "error.message", error.message);
  appendErrorDetails(lines, error.details);
  appendCliNextHints(lines, error.next);
  appendNativeNextHints(lines, error.native_next);
}

function appendErrorDetails(lines: string[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const detail of value.slice(0, MAX_ERROR_DETAILS)) {
    if (!isPlainRecord(detail)) continue;
    const parts = ERROR_DETAIL_FIELDS
      .map((field) => safeKeyValue(field, detail[field]))
      .filter((part): part is string => Boolean(part));
    if (parts.length > 0) lines.push(`detail: ${parts.join(", ")}`);
  }
}

function appendCliNextHints(lines: string[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value.slice(0, MAX_NEXT_HINTS)) {
    if (typeof item === "string") {
      pushSafeLine(lines, "next", item);
      continue;
    }
    if (!isPlainRecord(item)) continue;
    const command = safeText(item.command);
    const reason = safeText(item.reason);
    if (!command && !reason) continue;
    lines.push(`next: ${[command, reason].filter(Boolean).join(" | ")}`);
  }
}

function appendNativeNextHints(lines: string[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value.slice(0, MAX_NEXT_HINTS)) {
    if (!isPlainRecord(item)) continue;
    const tool = safeText(item.tool);
    const args = isPlainRecord(item.args) ? safeArgsText(item.args) : "";
    const reason = safeText(item.reason);
    if (!tool && !args && !reason) continue;
    const action = [tool, args].filter(Boolean).join(" ");
    lines.push(`native_next: ${[action, reason].filter(Boolean).join(" | ")}`);
  }
}

function safeArgsText(args: Record<string, unknown>): string {
  return Object.entries(args)
    .slice(0, MAX_ARG_FIELDS)
    .map(([key, value]) => safeArgKeyValue(key, value))
    .filter((part): part is string => Boolean(part))
    .join(", ");
}

function safeArgKeyValue(key: string, value: unknown): string | null {
  const safeKey = safeText(key);
  if (!safeKey) return null;
  if (isSensitiveKey(key)) return `${safeKey}: ${REDACTED_VALUE}`;
  const safeValue = safePrimitiveText(value);
  if (!safeValue) return null;
  return `${safeKey}: ${safeValue}`;
}

function safeKeyValue(key: string, value: unknown): string | null {
  const safeKey = safeText(key);
  const safeValue = safePrimitiveText(value);
  if (!safeKey || !safeValue) return null;
  return `${safeKey}: ${safeValue}`;
}

function pushSafeLine(lines: string[], label: string, value: unknown): void {
  const safeValue = safePrimitiveText(value);
  if (!safeValue) return;
  lines.push(`${label}: ${safeValue}`);
}

function safePrimitiveText(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return safeText(value);
}

function safeText(value: unknown): string | null {
  const candidate = typeof value === "string" ? redactPrivatePaths(value) : value;
  const safe = safeOptionalPublicText(candidate);
  if (!safe) return null;
  const redacted = redactPrivatePaths(safe).trim();
  return redacted || null;
}

function redactPrivatePaths(value: string): string {
  let output = "";
  let index = 0;
  while (index < value.length) {
    if (!isPrivatePathStart(value, index)) {
      output += value[index];
      index += 1;
      continue;
    }
    output += REDACTED_PATH;
    index = privatePathEnd(value, index);
  }
  return output;
}

function isPrivatePathStart(value: string, index: number): boolean {
  if (value.startsWith("file://", index)) return true;
  if (value.startsWith("~/", index)) return true;
  if (isBoundaryBeforePath(value, index) && /^[A-Za-z]:[\\/]/u.test(value.slice(index, index + 3))) return true;
  if (value[index] !== "/" || value[index + 1] === "/") return false;
  return value[index - 1] !== "/";
}

function isBoundaryBeforePath(value: string, index: number): boolean {
  const previous = value[index - 1];
  return !previous || /\s/u.test(previous) || "\"'`:=({[".includes(previous);
}

function privatePathEnd(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    if (isPathBoundary(value, index)) break;
    if (isNextCliFlag(value, index)) break;
    index += 1;
  }
  return index;
}

function isPathBoundary(value: string, index: number): boolean {
  return /[\n\r"'`<>|;)\]}]/u.test(value[index] ?? "");
}

function isNextCliFlag(value: string, index: number): boolean {
  return value[index] === " " && value[index + 1] === "-" && value[index + 2] === "-";
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "");
  return [
    "apikey",
    "token",
    "secret",
    "password",
    "passphrase",
    "authorization",
    "auth",
    "credential",
    "credentials",
    "accesstoken",
    "refreshtoken",
    "privatekey",
    "sessionkey",
    "cookie",
    "setcookie",
  ].some((term) => normalized.includes(term));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function limitSummary(value: string): string {
  if (value.length <= SUMMARY_OUTPUT_LIMIT) return value;
  return `${value.slice(0, SUMMARY_OUTPUT_LIMIT)}\n...[tool result summary truncated]`;
}
