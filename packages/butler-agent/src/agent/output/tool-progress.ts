import { homedir } from "os";
import { basename } from "path";
import type { RuntimeMessageLanguage } from "./messages.ts";
import type { ToolProgressSummary } from "../turn/native/output/tool-types.ts";

export function summarizeToolProgress(
  name: string,
  args: Record<string, unknown>,
  language: RuntimeMessageLanguage,
): ToolProgressSummary {
  const contextual = contextualToolProgressSummary(name, args);
  if (contextual) {
    return {
      ...contextual,
      workBlockLabel: workBlockLabelForTool(name, contextual.kind, contextual.inputLabel, language),
    };
  }
  const kind = activityKindForTool(name);
  const toolName = displayToolName(name, kind);
  const inputLabel = safeToolInputLabel(name, args, kind);
  return {
    kind,
    toolName,
    safeLabel: inputLabel ? `${toolName}: ${inputLabel}` : toolName,
    workBlockLabel: workBlockLabelForTool(name, kind, inputLabel, language),
    inputLabel,
    detailRows: safeToolDetailRows(name, args),
  };
}

function contextualToolProgressSummary(
  name: string,
  args: Record<string, unknown>,
): Omit<ToolProgressSummary, "workBlockLabel"> | null {
  if (name === "inspect_project_status") {
    return {
      kind: "read",
      toolName: "Project Ledger",
      safeLabel: "Checking local Project Ledger status",
      inputLabel: "status",
      detailRows: projectLedgerDetailRows([
        { id: "workspace", label: "Workspace", value: args.project_path },
      ]),
    };
  }
  if (name === "query_project_work") {
    return {
      kind: "searched",
      toolName: "Project Ledger",
      safeLabel: `Reviewing Project Ledger ${projectLedgerQueryLabel(args.kind)}`,
      inputLabel: projectLedgerQueryLabel(args.kind),
      detailRows: projectLedgerDetailRows([
        { id: "workspace", label: "Workspace", value: args.project_path },
        { id: "query", label: "Query", value: projectLedgerQueryLabel(args.kind) },
      ]),
    };
  }
  if (name === "web_read") {
    const source = safeUrlHostLabel(args.url);
    return {
      kind: "read",
      toolName: "Web read",
      safeLabel: source ? `Reading public source: ${source}` : "Reading public source",
      inputLabel: source,
      detailRows: source
        ? [{
          id: "web-read-source",
          kind: "source",
          safe_label: "Source",
          safe_value: source,
          state: "running",
        }]
        : [],
    };
  }
  if (name === "summarize_user_profile") {
    return {
      kind: "read",
      toolName: "Profile",
      safeLabel: "Summarizing Butler profile understanding",
      inputLabel: "profile summary",
      detailRows: [],
    };
  }
  if (name === "render_project_dashboard") {
    const view = safeTextValue(args.view, "dashboard");
    return {
      kind: args.write === true ? "edited" : "used_tool",
      toolName: "Project Ledger",
      safeLabel: `Rendering Project Ledger ${view} view`,
      inputLabel: `${view} view`,
      detailRows: projectLedgerDetailRows([
        { id: "workspace", label: "Workspace", value: args.project_path },
        { id: "view", label: "View", value: view },
        { id: "output", label: "Output", value: args.write === true ? "writing generated view" : "preview only" },
      ]),
    };
  }
  if (name === "transform_public_data_table") {
    const title = safeTextValue(args.title, "public data table");
    const rowCount = Array.isArray(args.rows) ? String(args.rows.length) : "";
    return {
      kind: "edited",
      toolName: "Data transform",
      safeLabel: `Transforming public data table: ${title}`,
      inputLabel: title,
      detailRows: [
        {
          id: "public-data-title",
          kind: "title",
          safe_label: "Table",
          safe_value: title,
          state: "running",
        },
        ...(rowCount
          ? [{
            id: "public-data-rows",
            kind: "rows",
            safe_label: "Rows",
            safe_value: rowCount,
            state: "running",
          }]
          : []),
      ],
    };
  }
  return null;
}

function projectLedgerQueryLabel(value: unknown): string {
  const kind = safeTextValue(value, "work").replace(/-/gu, " ");
  if (kind === "next actions") return "next actions";
  return kind;
}

function safeUrlHostLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./iu, "").slice(0, 80);
  } catch {
    return "";
  }
}

function projectLedgerDetailRows(
  rows: Array<{ id: string; label: string; value: unknown }>,
): ToolProgressSummary["detailRows"] {
  return rows
    .map((row) => {
      const safeValue = row.id === "workspace"
        ? safePathishValue(row.value, "workspace")
        : safeTextValue(row.value, row.label);
      return {
        id: `project-ledger-${row.id}`,
        kind: row.id,
        safe_label: row.label,
        safe_value: safeValue,
        state: "running",
      };
    })
    .filter((row) => row.safe_value && row.safe_value !== "undefined")
    .slice(0, 6);
}

export function activityKindForTool(name: string): ToolProgressSummary["kind"] {
  const normalized = name.toLocaleLowerCase("en-US");
  if (/dispatch|resume_worker|orchestration|stream/u.test(normalized)) return "dispatch";
  if (/edit|write|patch|modify|transform|csv|table/u.test(normalized)) return "edited";
  if (/bash|shell|command|exec|run/u.test(normalized)) return "ran_command";
  if (/search|query|web/u.test(normalized)) return "searched";
  if (/read|open|cat|inspect/u.test(normalized)) return "read";
  return "used_tool";
}

export function displayToolName(name: string, kind: ToolProgressSummary["kind"]): string {
  if (kind === "ran_command") return "Bash";
  if (kind === "edited") return "Edit";
  if (kind === "searched") return name.includes("web") ? "Web search" : "Search";
  if (kind === "read") return "Read";
  if (kind === "dispatch") return "Dispatch";
  return name
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((part) => part[0]?.toLocaleUpperCase("en-US") + part.slice(1))
    .join(" ") || "Tool";
}

function workBlockLabelForTool(
  name: string,
  kind: ToolProgressSummary["kind"],
  inputLabel: string,
  language: RuntimeMessageLanguage,
): string {
  const normalized = name.toLocaleLowerCase("en-US");
  if (language === "ko") {
    if (normalized === "inspect_project_status") return "프로젝트 원장 상태를 확인합니다.";
    if (normalized === "query_project_work") return "프로젝트 원장에서 필요한 작업 맥락을 확인합니다.";
    if (normalized === "render_project_dashboard") return "프로젝트 원장 대시보드를 갱신합니다.";
    if (normalized === "web_search") {
      return inputLabel
        ? `공개 웹에서 "${inputLabel}" 관련 정보를 검색합니다.`
        : "공개 웹에서 필요한 정보를 검색합니다.";
    }
    if (normalized === "web_read") return "선택한 출처의 내용을 확인합니다.";
    if (normalized === "summarize_user_profile") return "버틀러가 사용자를 어떻게 이해하고 있는지 요약합니다.";
    if (normalized === "transform_public_data_table") return "수집한 공개 데이터를 표로 정제합니다.";
    if (normalized === "read_conversation_context") return "이전 대화 맥락에서 필요한 단서를 확인합니다.";
    if (normalized === "list_work_streams") return "진행 중인 작업 흐름을 확인합니다.";
    if (normalized === "update_work_stream_state") return "작업 흐름의 상태를 갱신합니다.";
    if (kind === "dispatch") return "필요한 하위 작업을 맡기고 진행 상황을 추적합니다.";
    if (kind === "edited") return "필요한 파일 변경을 적용합니다.";
    if (kind === "ran_command") return "로컬 명령으로 현재 상태를 확인합니다.";
    if (kind === "searched") return "필요한 자료를 검색합니다.";
    if (kind === "read") return "필요한 내용을 읽어 근거를 확인합니다.";
    return inputLabel ? "필요한 도구 작업을 수행합니다." : "작업에 필요한 도구를 사용합니다.";
  }
  if (normalized === "inspect_project_status") return "Checking the Project Ledger status.";
  if (normalized === "query_project_work") return "Reviewing the needed Project Ledger work context.";
  if (normalized === "render_project_dashboard") return "Updating the Project Ledger dashboard.";
  if (normalized === "web_search") {
    return inputLabel
      ? `Searching public web sources for ${inputLabel}.`
      : "Searching public web sources for the needed information.";
  }
  if (normalized === "web_read") return "Reading the selected source for evidence.";
  if (normalized === "summarize_user_profile") return "Summarizing Butler's understanding of the user.";
  if (normalized === "transform_public_data_table") return "Transforming collected public data into a table.";
  if (normalized === "read_conversation_context") return "Checking prior conversation context for relevant clues.";
  if (normalized === "list_work_streams") return "Checking active work streams.";
  if (normalized === "update_work_stream_state") return "Updating the work stream state.";
  if (kind === "dispatch") return "Delegating the needed subtask and tracking progress.";
  if (kind === "edited") return "Applying the needed file changes.";
  if (kind === "ran_command") return "Checking the current state with a local command.";
  if (kind === "searched") return "Searching for the needed material.";
  if (kind === "read") return "Reading the needed material for evidence.";
  return inputLabel ? "Running the needed tool work." : "Using a tool needed for this task.";
}

function safeToolInputLabel(
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

function safeToolDetailRows(
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
