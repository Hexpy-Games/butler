import { homedir } from "os";
import { basename } from "path";
import type { ToolProgressSummary } from "../../tool-support/index.ts";

export function safeToolInputLabel(
  name: string,
  args: Record<string, unknown>,
  kind: ToolProgressSummary["kind"],
): string {
  if (kind === "dispatch") return safeTextValue(args.objective ?? args.title ?? args.summary, "background task");
  if (kind === "edited" || kind === "read") return safePathishValue(args.path ?? args.file_path ?? args.file ?? args.target, name);
  if (kind === "ran_command") return safeCommandValue(args.command ?? args.cmd ?? args.argv ?? args.args, name);
  if (kind === "searched") return safeTextValue(args.query ?? args.pattern ?? args.q ?? args.keyword, "");
  return safeTextValue(args.summary ?? args.name ?? args.query ?? args.path, name);
}

export function safeToolDetailRows(
  name: string,
  args: Record<string, unknown>,
): ToolProgressSummary["detailRows"] {
  const rows: ToolProgressSummary["detailRows"] = [];
  for (const key of ["path", "file_path", "target", "query", "pattern", "command", "cmd", "objective"]) {
    if (!(key in args)) continue;
    const value = key.includes("path") || key === "target"
      ? safePathishValue(args[key], key)
      : key === "command" || key === "cmd"
        ? safeCommandValue(args[key], key)
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

function safeCommandValue(value: unknown, fallback: string): string {
  const text = Array.isArray(value)
    ? value.map((part) => String(part)).join(" ")
    : typeof value === "string"
      ? value
      : "";
  return safePathishValue(text, fallback);
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

export function safeTextValue(value: unknown, fallback: string): string {
  const text = typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
  const normalized = stripControlCharacters(text)
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return (normalized || fallback).slice(0, 140);
}

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
}
