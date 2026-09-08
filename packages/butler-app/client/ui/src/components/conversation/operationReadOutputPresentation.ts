import { appCopy } from "@/app/copy.ts";
import type { OperationOutputPresentation, OperationOutputSection } from "./operationOutputPresentation";

type OutputRecord = Record<string, unknown>;

export function presentReadOperation(
  toolName: string | undefined,
  value: OutputRecord,
): OperationOutputPresentation | null {
  if (toolName === "read_file" && Array.isArray(value.files)) {
    const files = records(value.files);
    const read = files.filter((file) => file.ok === true && !file.skipped).length;
    return {
      kind: "sections",
      summary: appCopy.interfaceStatus.countSummary("filesRead", `${read}/${files.length}`, Boolean(value.truncated)),
      sections: files.map(readFileSection),
    };
  }
  if (toolName === "list_files" && Array.isArray(value.files)) {
    const files = records(value.files);
    return {
      kind: "sections",
      summary: appCopy.interfaceStatus.countSummary("files", files.length, Boolean(value.truncated)),
      sections: files.map((file) => ({
        title: displayPath(file.path),
        message: typeof file.bytes === "number" ? appCopy.interfaceStatus.bytes(file.bytes) : undefined,
      })),
    };
  }
  if (toolName === "grep_files" && Array.isArray(value.matches)) {
    const matches = records(value.matches);
    return {
      kind: "sections",
      summary: appCopy.interfaceStatus.countSummary("matches", matches.length, Boolean(value.truncated)),
      sections: matches.map((match) => ({
        title: `${displayPath(match.path)}${typeof match.line === "number" ? ` · ${appCopy.interfaceStatus.lines(match.line)}` : ""}`,
        content: text(match.text),
      })),
    };
  }
  const data = record(value.data);
  if (value.ok === true && toolName === "project_ledger_list" && Array.isArray(data?.results)) {
    const documents = records(data.results);
    return { kind: "sections", summary: appCopy.interfaceStatus.countSummary("documents", documents.length), sections: documents.map(documentSection) };
  }
  if (value.ok === true && toolName === "project_ledger_show" && data) {
    return { kind: "sections", summary: appCopy.interfaceStatus.documentRead, sections: [documentSection(data)] };
  }
  return null;
}

function readFileSection(file: OutputRecord): OperationOutputSection {
  const start = file.start_line;
  const end = file.end_line;
  const range = typeof start === "number" && typeof end === "number" && end >= start
    ? ` · ${appCopy.interfaceStatus.lines(start === end ? start : `${start}–${end}`)}`
    : "";
  const title = `${displayPath(file.path)}${range}`;
  if (file.pending) return { title, message: appCopy.interfaceStatus.pendingRead };
  if (file.skipped) return { title, message: appCopy.interfaceStatus.skippedRead };
  if (file.ok !== true) return { title, message: readFailureMessage(file.error) };
  const content = text(file.content);
  return {
    title,
    content,
    message: file.truncated ? appCopy.interfaceStatus.truncatedRead
      : content.length === 0 ? appCopy.interfaceStatus.emptyText : undefined,
  };
}

function readFailureMessage(error: unknown): string {
  const code = typeof error === "string" ? error : text(record(error)?.code);
  const labels: Record<string, string> = {
    not_found: appCopy.interfaceStatus.fileNotFound,
    not_a_file: appCopy.interfaceStatus.notFile,
    sensitive_path_blocked: appCopy.interfaceStatus.sensitiveFile,
    protected_path: appCopy.interfaceStatus.protectedFile,
    binary_file_not_supported: appCopy.interfaceStatus.binaryFile,
    invalid_utf8: appCopy.interfaceStatus.invalidUtf8,
    io_error: appCopy.interfaceStatus.ioError,
    max_total_bytes: appCopy.interfaceStatus.maxBytes,
    max_bytes_too_small_for_utf8: appCopy.interfaceStatus.maxBytesUtf8,
  };
  return labels[code] ?? appCopy.interfaceStatus.readFailed;
}

function documentSection(document: OutputRecord): OperationOutputSection {
  const kinds: Record<string, string> = { spec: appCopy.interfaceStatus.spec, plan: appCopy.interfaceStatus.planning, work: appCopy.interfaceStatus.work, task: appCopy.interfaceStatus.task, review: appCopy.interfaceStatus.reviewNoun, report: appCopy.interfaceStatus.report, result: appCopy.interfaceStatus.result };
  const statuses: Record<string, string> = { draft: appCopy.interfaceStatus.draft, active: appCopy.interfaceStatus.inProgress, in_progress: appCopy.interfaceStatus.inProgress, done: appCopy.interfaceStatus.completed, blocked: appCopy.interfaceStatus.blocked, specified: appCopy.interfaceStatus.specified, accepted: appCopy.interfaceStatus.accepted, planned: appCopy.interfaceStatus.planned, cancelled: appCopy.interfaceStatus.cancelled };
  return {
    title: text(document.title) || appCopy.interfaceStatus.document,
    message: [kinds[text(document.kind)], statuses[text(document.status)]].filter(Boolean).join(" · ") || undefined,
    content: typeof document.body === "string" ? document.body : undefined,
  };
}

function displayPath(value: unknown): string {
  const path = text(value).replace(/\\/gu, "/");
  if (!path) return appCopy.interfaceStatus.file;
  return path.startsWith("/") || /^[a-z]:\//iu.test(path) ? path.split("/").at(-1) || appCopy.interfaceStatus.file : path;
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
