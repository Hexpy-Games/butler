import type { OperationOutputPresentation, OperationOutputSection } from "./operationOutputPresentation";

type OutputRecord = Record<string, unknown>;
const TEXT_KEYS = ["analysis", "markdown", "body", "content", "text", "summary", "description", "message", "snippet", "bounded_content", "csv_preview"];
const COLLECTION_KEYS = ["descriptions", "tools", "capabilities", "results", "matches", "documents", "messages", "summaries", "items", "entries", "sessions", "skills", "servers", "resources", "public_web_evidence_items", "evidence_items", "content", "contents"];
const ENVELOPE_KEYS = ["output", "result", "data", "work", "text", "stdout", "stderr"];

/** Display public content fields, never dump receipts, identities or raw JSON. */
export function presentStructuredOperation(value: OutputRecord): OperationOutputPresentation | null {
  if (value.pending === true || value.authority_pending === true) {
    return { kind: "summary", content: "아직 실행하지 않았습니다. 허용 여부를 기다리고 있습니다." };
  }
  const error = record(value.error);
  if (value.ok === false && (error?.message || typeof value.error === "string")) {
    return { kind: "sections", summary: "도구 실행 실패", sections: [{
      title: "실패 원인", content: text(error?.message) || text(value.error),
    }] };
  }
  const sections = publicSections(value);
  if (sections.length === 0) return null;
  return { kind: "sections", summary: value.ok === false ? "도구 실행 실패" : `조회 결과 · ${sections.length}개`, sections };
}

function publicSections(value: OutputRecord): OperationOutputSection[] {
  const title = text(value.title) || text(value.label) || text(value.display_name) || text(value.name) || "결과";
  const parts = [...new Set(TEXT_KEYS.flatMap((key) => typeof value[key] === "string" && value[key] ? [value[key]] : []))];
  if (typeof value.row_count === "number" && Array.isArray(value.columns)) {
    parts.unshift(`${value.row_count}행 · ${value.columns.length}열${typeof value.artifact_label === "string" ? ` · ${value.artifact_label}` : ""}`);
  }
  const schema = record(value.schema) ?? record(value.input_schema);
  const properties = record(schema?.properties);
  if (properties) {
    parts.push("입력 항목\n" + Object.entries(properties).map(([key, entry]) => {
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
  if (!own.length && title !== "결과") own.push({ title });
  return own;
}

function record(value: unknown): OutputRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as OutputRecord : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
