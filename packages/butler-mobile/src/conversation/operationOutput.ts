import type { GatewayClient } from "../../../butler-protocol/src/client/index.ts";
import type { OperationOutputView } from "../../../butler-protocol/src/index.ts";
import type { AppCopy } from "../../../butler-i18n/src/index.ts";

export type OperationOutputSection = { title: string; content?: string; message?: string };

export type OperationOutputPresentation =
  | { kind: "code"; content: string }
  | { kind: "summary"; content: string }
  | { kind: "command"; summary: string; command?: string; content?: string }
  | { kind: "sections"; summary: string; sections: OperationOutputSection[] };

export function presentOperationOutput(
  toolName: string | undefined,
  content: string,
  complete: boolean,
  copy: AppCopy,
): OperationOutputPresentation {
  if (!complete) {
    return {
      kind: "summary",
      content: copy.interfaceStatus.partialOutput,
    };
  }
  const value = operationResultRecord(content);
  if (!value) return { kind: "code", content };
  if (toolName === "run_command") return commandOutput(value, copy);
  const readOutput = presentReadOperation(toolName, value, copy);
  if (readOutput) return readOutput;
  if (value.ok === false || value.pending === true || value.authority_pending === true) {
    const failure = presentStructuredOperation(value, copy);
    if (failure) return failure;
  }
  if (isBasicFileTool(toolName)) return basicFileOutput(toolName, value, copy);
  const structured = presentStructuredOperation(value, copy);
  if (structured) return structured;
  if (typeof value.ok === "boolean") {
    return {
      kind: "summary",
      content: value.ok ? copy.interfaceStatus.noDetailSupport : copy.interfaceStatus.operationFailed,
    };
  }
  return { kind: "summary", content: copy.interfaceStatus.resultChecked };
}

function commandOutput(value: Record<string, unknown>, copy: AppCopy): OperationOutputPresentation {
  const timedOut = value.timed_out === true;
  const exitCode = typeof value.exit_code === "number" ? value.exit_code : undefined;
  const succeeded = value.ok === true && !timedOut && (exitCode === undefined || exitCode === 0);
  const summary = timedOut
    ? copy.interfaceStatus.commandTimeout
    : `${succeeded ? copy.interfaceStatus.commandDone : copy.interfaceStatus.commandFailed}${
      exitCode === undefined ? "" : ` · ${copy.interfaceStatus.exitCode(exitCode)}`
    }`;
  const stdout = stringValue(value.stdout);
  const stderr = stringValue(value.stderr);
  const output = commandText(stdout, stderr, copy);
  return { kind: "command", summary,
    ...(typeof value.command === "string" ? { command: value.command } : {}),
    ...(output ? { content: output } : {}),
  };
}

function commandText(stdout: string, stderr: string, copy: AppCopy): string {
  if (stdout && stderr) return copy.interfaceStatus.commandStreams(stdout, stderr);
  return stdout || stderr;
}

function basicFileOutput(
  toolName: "edit_file" | "write_file" | "read_file",
  value: Record<string, unknown>,
  copy: AppCopy,
): OperationOutputPresentation {
  if (value.ok !== true) {
    return { kind: "summary", content: copy.interfaceStatus.fileFailed };
  }
  if (toolName === "read_file" && typeof value.content === "string") {
    return { kind: "code", content: value.content };
  }
  const fileName = operationFileName(value.path);
  if (!fileName) return { kind: "summary", content: copy.interfaceStatus.fileDone };
  const action = toolName === "edit_file" ? copy.interfaceStatus.editDone : copy.interfaceStatus.writeDone;
  const byteLabel = typeof value.bytes === "number"
    ? ` · ${copy.interfaceStatus.bytes(value.bytes)}`
    : "";
  return { kind: "summary", content: `${action} · ${fileName}${byteLabel}` };
}

function operationResultRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isBasicFileTool(
  value: string | undefined,
): value is "edit_file" | "write_file" | "read_file" {
  return value === "edit_file" || value === "write_file" || value === "read_file";
}

function operationFileName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\\/gu, "/").split("/").filter(Boolean).at(-1) ?? "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type OutputRecord = Record<string, unknown>;

export function presentReadOperation(
  toolName: string | undefined,
  value: OutputRecord,
  copy: AppCopy,
): OperationOutputPresentation | null {
  if (toolName === "read_file" && Array.isArray(value.files)) {
    const files = records(value.files);
    const read = files.filter((file) => file.ok === true && !file.skipped).length;
    return {
      kind: "sections",
      summary: copy.interfaceStatus.countSummary("filesRead", `${read}/${files.length}`, Boolean(value.truncated)),
      sections: files.map(file => readFileSection(file, copy)),
    };
  }
  if (toolName === "list_files" && Array.isArray(value.files)) {
    const files = records(value.files);
    return {
      kind: "sections",
      summary: copy.interfaceStatus.countSummary("files", files.length, Boolean(value.truncated)),
      sections: files.map((file) => ({
        title: displayPath(file.path, copy),
        message: typeof file.bytes === "number" ? copy.interfaceStatus.bytes(file.bytes) : undefined,
      })),
    };
  }
  if (toolName === "grep_files" && Array.isArray(value.matches)) {
    const matches = records(value.matches);
    return {
      kind: "sections",
      summary: copy.interfaceStatus.countSummary("matches", matches.length, Boolean(value.truncated)),
      sections: matches.map((match) => ({
        title: `${displayPath(match.path, copy)}${typeof match.line === "number" ? ` · ${copy.interfaceStatus.lines(match.line)}` : ""}`,
        content: text(match.text),
      })),
    };
  }
  const data = record(value.data);
  if (value.ok === true && toolName === "project_ledger_list" && Array.isArray(data?.results)) {
    const documents = records(data.results);
    return { kind: "sections", summary: copy.interfaceStatus.countSummary("documents", documents.length), sections: documents.map(document => documentSection(document, copy)) };
  }
  if (value.ok === true && toolName === "project_ledger_show" && data) {
    return { kind: "sections", summary: copy.interfaceStatus.documentRead, sections: [documentSection(data, copy)] };
  }
  return null;
}

function readFileSection(file: OutputRecord, copy: AppCopy): OperationOutputSection {
  const start = file.start_line;
  const end = file.end_line;
  const range = typeof start === "number" && typeof end === "number" && end >= start
    ? ` · ${copy.interfaceStatus.lines(start === end ? start : `${start}–${end}`)}`
    : "";
  const title = `${displayPath(file.path, copy)}${range}`;
  if (file.pending) return { title, message: copy.interfaceStatus.pendingRead };
  if (file.skipped) return { title, message: copy.interfaceStatus.skippedRead };
  if (file.ok !== true) return { title, message: readFailureMessage(file.error, copy) };
  const content = text(file.content);
  return {
    title,
    content,
    message: file.truncated ? copy.interfaceStatus.truncatedRead
      : content.length === 0 ? copy.interfaceStatus.emptyText : undefined,
  };
}

function readFailureMessage(error: unknown, copy: AppCopy): string {
  const code = typeof error === "string" ? error : text(record(error)?.code);
  const labels: Record<string, string> = {
    not_found: copy.interfaceStatus.fileNotFound,
    not_a_file: copy.interfaceStatus.notFile,
    sensitive_path_blocked: copy.interfaceStatus.sensitiveFile,
    protected_path: copy.interfaceStatus.protectedFile,
    binary_file_not_supported: copy.interfaceStatus.binaryFile,
    invalid_utf8: copy.interfaceStatus.invalidUtf8,
    io_error: copy.interfaceStatus.ioError,
    max_total_bytes: copy.interfaceStatus.maxBytes,
    max_bytes_too_small_for_utf8: copy.interfaceStatus.maxBytesUtf8,
  };
  return labels[code] ?? copy.interfaceStatus.readFailed;
}

function documentSection(document: OutputRecord, copy: AppCopy): OperationOutputSection {
  const kinds: Record<string, string> = { spec: copy.interfaceStatus.spec, plan: copy.interfaceStatus.planning, work: copy.interfaceStatus.work, task: copy.interfaceStatus.task, review: copy.interfaceStatus.reviewNoun, report: copy.interfaceStatus.report, result: copy.interfaceStatus.result };
  const statuses: Record<string, string> = { draft: copy.interfaceStatus.draft, active: copy.interfaceStatus.inProgress, in_progress: copy.interfaceStatus.inProgress, done: copy.interfaceStatus.completed, blocked: copy.interfaceStatus.blocked, specified: copy.interfaceStatus.specified, accepted: copy.interfaceStatus.accepted, planned: copy.interfaceStatus.planned, cancelled: copy.interfaceStatus.cancelled };
  return {
    title: text(document.title) || copy.interfaceStatus.document,
    message: [kinds[text(document.kind)], statuses[text(document.status)]].filter(Boolean).join(" · ") || undefined,
    content: typeof document.body === "string" ? document.body : undefined,
  };
}

function displayPath(value: unknown, copy: AppCopy): string {
  const path = text(value).replace(/\\/gu, "/");
  if (!path) return copy.interfaceStatus.file;
  return path.startsWith("/") || /^[a-z]:\//iu.test(path) ? path.split("/").at(-1) || copy.interfaceStatus.file : path;
}

function record(value: unknown): OutputRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as OutputRecord : null;
}

function records(value: unknown[]): OutputRecord[] {
  return value.flatMap((item) => { const parsed = record(item); return parsed ? [parsed] : []; });
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const TEXT_KEYS = ["analysis", "markdown", "body", "content", "text", "summary", "description", "message", "snippet", "bounded_content", "csv_preview"];
const COLLECTION_KEYS = ["descriptions", "tools", "capabilities", "results", "matches", "documents", "messages", "summaries", "items", "entries", "sessions", "skills", "servers", "resources", "public_web_evidence_items", "evidence_items", "content", "contents"];
const ENVELOPE_KEYS = ["output", "result", "data", "work", "text", "stdout", "stderr"];

/** Display public content fields, never dump receipts, identities or raw JSON. */
export function presentStructuredOperation(value: OutputRecord, copy: AppCopy): OperationOutputPresentation | null {
  if (value.pending === true || value.authority_pending === true) {
    return { kind: "summary", content: copy.interfaceStatus.notExecuted };
  }
  const error = record(value.error);
  if (value.ok === false && (error?.message || typeof value.error === "string")) {
    return { kind: "sections", summary: copy.interfaceStatus.toolFailed, sections: [{
      title: copy.interfaceStatus.failureReason, content: text(error?.message) || text(value.error),
    }] };
  }
  const sections = publicSections(value, copy);
  if (sections.length === 0) return null;
  return { kind: "sections", summary: value.ok === false ? copy.interfaceStatus.toolFailed : copy.interfaceStatus.countSummary("results", sections.length), sections };
}

function publicSections(value: OutputRecord, copy: AppCopy): OperationOutputSection[] {
  const title = text(value.title) || text(value.label) || text(value.display_name) || text(value.name) || copy.interfaceStatus.result;
  const parts = [...new Set(TEXT_KEYS.flatMap((key) => typeof value[key] === "string" && value[key] ? [value[key]] : []))];
  if (typeof value.row_count === "number" && Array.isArray(value.columns)) {
    parts.unshift(`${copy.interfaceStatus.dimensions(Number(value.row_count), value.columns.length)}${typeof value.artifact_label === "string" ? ` · ${value.artifact_label}` : ""}`);
  }
  const schema = record(value.schema) ?? record(value.input_schema);
  const properties = record(schema?.properties);
  if (properties) {
    parts.push(copy.interfaceStatus.inputFields + "\n" + Object.entries(properties).map(([key, entry]) => {
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
        if (object) own.push(...publicSections(object, copy));
      }
    }
  }
  for (const key of ENVELOPE_KEYS) {
    const nested = record(value[key]);
    if (nested) own.push(...publicSections(nested, copy));
  }
  if (!own.length && title !== copy.interfaceStatus.result) own.push({ title });
  return own;
}

export async function readOutputPage(
  client: GatewayClient, turnId: string, callId: string, resultId: string, offset: number, signal?: AbortSignal,
): Promise<OperationOutputView> {
  return await client.request<OperationOutputView>(
    `/turns/${encodeURIComponent(turnId)}/operations/${encodeURIComponent(callId)}` +
      `/output?result_id=${encodeURIComponent(resultId)}&offset=${offset}`, { signal },
  );
}
