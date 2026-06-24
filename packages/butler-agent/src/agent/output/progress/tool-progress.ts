import type { RuntimeMessageLanguage } from "../messages.ts";
import type { ToolProgressSummary } from "../../turn/native/output/tool-types.ts";
import { safeToolDetailRows, safeToolInputLabel } from "./arguments.ts";
import { contextualToolProgressSummary } from "./contextual.ts";
import { workBlockLabelForTool } from "./labels.ts";

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
