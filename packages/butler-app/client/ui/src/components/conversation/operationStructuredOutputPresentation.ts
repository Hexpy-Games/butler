import { appCopy } from "@/app/copy.ts";
import type { OperationOutputPresentation, OperationOutputSection } from "./operationOutputPresentation";

type OutputRecord = Record<string, unknown>;
const TEXT_KEYS = ["analysis", "markdown", "body", "content", "text", "summary", "description", "message", "snippet", "bounded_content", "csv_preview"];
const COLLECTION_KEYS = ["descriptions", "tools", "capabilities", "results", "matches", "documents", "messages", "summaries", "items", "entries", "sessions", "skills", "servers", "resources", "public_web_evidence_items", "evidence_items", "content", "contents"];
const ENVELOPE_KEYS = ["output", "result", "data", "work", "text", "stdout", "stderr"];

/** Display public content fields, never dump receipts, identities or raw JSON. */
export function presentStructuredOperation(value: OutputRecord): OperationOutputPresentation | null {
  if (value.pending === true || value.authority_pending === true) {
    return { kind: "summary", content: appCopy.interfaceStatus.notExecuted };
  }
  const error = record(value.error);
  if (value.ok === false && (error?.message || typeof value.error === "string")) {
    return { kind: "sections", summary: appCopy.interfaceStatus.toolFailed, sections: [{
      title: appCopy.interfaceStatus.failureReason, content: text(error?.message) || text(value.error),
    }] };
  }
  const sections = publicSections(value);
  if (sections.length === 0) return null;
  return { kind: "sections", summary: value.ok === false ? appCopy.interfaceStatus.toolFailed : appCopy.interfaceStatus.countSummary("results", sections.length), sections };
}

function publicSections(value: OutputRecord): OperationOutputSection[] {
  const title = text(value.title) || text(value.label) || text(value.display_name) || text(value.name) || appCopy.interfaceStatus.result;
  const parts = [...new Set(TEXT_KEYS.flatMap((key) => typeof value[key] === "string" && value[key] ? [value[key]] : []))];
  if (typeof value.row_count === "number" && Array.isArray(value.columns)) {
    parts.unshift(`${appCopy.interfaceStatus.dimensions(Number(value.row_count), value.columns.length)}${typeof value.artifact_label === "string" ? ` · ${value.artifact_label}` : ""}`);
  }
  const schema = record(value.schema) ?? record(value.input_schema);
  const properties = record(schema?.properties);
  if (properties) {
    parts.push(appCopy.interfaceStatus.inputFields + "\n" + Object.entries(properties).map(([key, entry]) => {
      const field = record(entry);
      return [key, text(field?.type), text(field?.description)].filter(Boolean).join(" · ");
    }).join("\n"));
  }
  const own: OperationOutputSection[] = parts.length ? [{ title, content: parts.join("\n\n") }] : [];
  for (const key of COLLECTION_KEYS) {
    const entries = value[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry === "string") own.push({ title, content: entry });
      else {
        const object = record(entry);
        if (object) own.push(...publicSections(object));
      }
    }
  }
  for (const key of ENVELOPE_KEYS) {
    const nested = record(value[key]);
    if (nested) own.push(...publicSections(nested));
  }
  if (!own.length && title !== appCopy.interfaceStatus.result) own.push({ title });
  return own;
}

function record(value: unknown): OutputRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as OutputRecord : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
