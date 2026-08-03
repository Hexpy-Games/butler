import { homedir } from "os";
import { basename } from "path";
import { sanitizePublicText } from "../../events/public-text.ts";
import type { ToolProgressSummary } from "../../tools/tool-support.ts";

export function safeToolInputLabel(
  name: string,
  args: Record<string, unknown>,
  kind: ToolProgressSummary["kind"],
): string {
  if (kind === "dispatch") return safeTextValue(args.objective ?? args.title ?? args.summary, "background task");
  if (kind === "edited" || kind === "read") return safePathishValue(args.path ?? args.file_path ?? args.file ?? args.target, name);
  if (kind === "ran_command") return safeCommandActionLabel(args);
  if (kind === "searched") return safeTextValue(args.query ?? args.pattern ?? args.q ?? args.keyword, "");
  return safeTextValue(args.summary ?? args.name ?? args.query ?? args.path, name);
}

export function safeToolDetailRows(
  name: string,
  args: Record<string, unknown>,
): ToolProgressSummary["detailRows"] {
  if (name === "run_command" || name === "run_shell" || name === "shell" || name === "bash") {
    return safeCommandIntentDetails(name, args);
  }
  const rows: ToolProgressSummary["detailRows"] = [];
  for (const key of ["path", "file_path", "target", "query", "pattern", "command", "cmd", "objective"]) {
    if (!(key in args)) continue;
    const value = key.includes("path") || key === "target"
      ? safePathishValue(args[key], key)
      : key === "command" || key === "cmd"
        ? "명령 세부정보 숨김"
        : safeTextValue(args[key], key);
    if (!value) continue;
    rows.push({
      id: `${name}-${key}`,
      kind: key,
      safe_label: labelFromToolArgumentKey(key),
      safe_value: value,
      state: "running",
    });
  }
  return rows.slice(0, 6);
}

function labelFromToolArgumentKey(key: string): string {
  if (key === "cmd" || key === "command") return "Command";
  if (key === "file_path" || key === "path") return "Path";
  if (key === "objective") return "Objective";
  if (key === "query" || key === "pattern") return "Query";
  return key;
}

export function safePathishValue(value: unknown, fallback: string): string {
  const text = safeTextValue(value, fallback);
  if (!text.includes("/")) return text;
  const parts = text.split(/\s+/u).map((part) => {
    if (!part.includes("/")) return part;
    if (part.startsWith(homedir())) return `~/${part.slice(homedir().length).replace(/^\/+/u, "")}`;
    return basename(part) || part;
  });
  return parts.join(" ");
}

export function safeCommandActionLabel(args: Record<string, unknown>): string {
  return safeCommandActionIdentity(args);
}

export function safeCommandActionIdentity(args: Record<string, unknown>): string {
  const raw = typeof args.summary === "string" ? args.summary.trim() : "";
  if (!raw || /[\r\n]/u.test(raw) || [...raw].length > 32) return "";
  const label = sanitizePublicText(raw, "").trim();
  return [...label].length <= 32 ? label : "";
}

function safeCommandIntentDetails(
  name: string,
  args: Record<string, unknown>,
): ToolProgressSummary["detailRows"] {
  const rows: ToolProgressSummary["detailRows"] = [{
    id: `${name}-intent`,
    kind: "command_intent",
    safe_label: "Command",
    safe_value: safeCommandActionLabel(args),
    state: "running",
  }];
  if (Array.isArray(args.output_paths) && args.output_paths.length > 0) {
    rows.push({
      id: `${name}-outputs`,
      kind: "output_count",
      safe_label: "Outputs",
      safe_value: `${args.output_paths.length}개`,
      state: "running",
    });
  }
  return rows;
}

export function safeTextValue(value: unknown, fallback: string): string {
  return safeTextValueUnbounded(value, fallback).slice(0, 140);
}

function safeTextValueUnbounded(value: unknown, fallback: string): string {
  const text = typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
  const normalized = stripControlCharacters(text)
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized || fallback;
}

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
}
