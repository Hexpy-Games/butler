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
      summary: `파일 읽기 · ${read}/${files.length}개${value.truncated ? " · 일부 결과" : ""}`,
      sections: files.map(readFileSection),
    };
  }
  if (toolName === "list_files" && Array.isArray(value.files)) {
    const files = records(value.files);
    return {
      kind: "sections",
      summary: `파일 목록 · ${files.length}개${value.truncated ? " · 일부 결과" : ""}`,
      sections: files.map((file) => ({
        title: displayPath(file.path),
        message: typeof file.bytes === "number" ? `${file.bytes.toLocaleString("ko-KR")}바이트` : undefined,
      })),
    };
  }
  if (toolName === "grep_files" && Array.isArray(value.matches)) {
    const matches = records(value.matches);
    return {
      kind: "sections",
      summary: `검색 결과 · ${matches.length}건${value.truncated ? " · 일부 결과" : ""}`,
      sections: matches.map((match) => ({
        title: `${displayPath(match.path)}${typeof match.line === "number" ? ` · ${match.line}줄` : ""}`,
        content: text(match.text),
      })),
    };
  }
  const data = record(value.data);
  if (value.ok === true && toolName === "project_ledger_list" && Array.isArray(data?.results)) {
    const documents = records(data.results);
    return { kind: "sections", summary: `문서 목록 · ${documents.length}개`, sections: documents.map(documentSection) };
  }
  if (value.ok === true && toolName === "project_ledger_show" && data) {
    return { kind: "sections", summary: "문서 조회", sections: [documentSection(data)] };
  }
  return null;
}

function readFileSection(file: OutputRecord): OperationOutputSection {
  const start = file.start_line;
  const end = file.end_line;
  const range = typeof start === "number" && typeof end === "number" && end >= start
    ? ` · ${start === end ? start : `${start}–${end}`}줄`
    : "";
  const title = `${displayPath(file.path)}${range}`;
  if (file.pending) return { title, message: "아직 읽지 않았습니다. 이어 읽을 결과가 있습니다." };
  if (file.skipped) return { title, message: "이전 출력에서 읽은 파일입니다." };
  if (file.ok !== true) return { title, message: readFailureMessage(file.error) };
  const content = text(file.content);
  return {
    title,
    content,
    message: file.truncated ? "일부만 읽었습니다. 이어 읽을 결과가 있습니다."
      : content.length === 0 ? "반환된 텍스트가 없습니다." : undefined,
  };
}

function readFailureMessage(error: unknown): string {
  const code = typeof error === "string" ? error : text(record(error)?.code);
  const labels: Record<string, string> = {
    not_found: "파일을 찾을 수 없습니다.",
    not_a_file: "일반 파일이 아닙니다.",
    sensitive_path_blocked: "민감한 파일로 분류되어 읽기가 제한되었습니다.",
    protected_path: "전용 조회 도구로 읽어야 하는 파일입니다.",
    binary_file_not_supported: "텍스트 읽기를 지원하지 않는 파일입니다.",
    invalid_utf8: "UTF-8 텍스트로 읽을 수 없습니다.",
    io_error: "파일을 읽는 중 입출력 오류가 발생했습니다.",
    max_total_bytes: "출력 용량 제한으로 이 파일을 읽지 못했습니다.",
    max_bytes_too_small_for_utf8: "출력 용량이 한 글자를 읽기에도 부족합니다.",
  };
  return labels[code] ?? "파일을 읽지 못했습니다.";
}

function documentSection(document: OutputRecord): OperationOutputSection {
  const kinds: Record<string, string> = { spec: "스펙", plan: "계획", work: "작업", task: "세부 작업", review: "리뷰", report: "보고서", result: "결과" };
  const statuses: Record<string, string> = { draft: "초안", active: "진행 중", in_progress: "진행 중", done: "완료", blocked: "진행 중단", specified: "작성됨", accepted: "수락됨", planned: "계획됨", cancelled: "중단됨" };
  return {
    title: text(document.title) || "문서",
    message: [kinds[text(document.kind)], statuses[text(document.status)]].filter(Boolean).join(" · ") || undefined,
    content: typeof document.body === "string" ? document.body : undefined,
  };
}

function displayPath(value: unknown): string {
  const path = text(value).replace(/\\/gu, "/");
  if (!path) return "파일";
  return path.startsWith("/") || /^[a-z]:\//iu.test(path) ? path.split("/").at(-1) || "파일" : path;
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
