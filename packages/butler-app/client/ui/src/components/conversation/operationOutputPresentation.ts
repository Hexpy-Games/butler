export type OperationOutputPresentation =
  | { kind: "code"; content: string }
  | { kind: "summary"; content: string }
  | { kind: "command"; summary: string; content?: string };

export function presentOperationOutput(
  toolName: string | undefined,
  content: string,
  complete: boolean,
): OperationOutputPresentation {
  if (!complete) {
    return {
      kind: "summary",
      content: "결과 일부를 불러왔습니다. 전체 결과를 보려면 출력 더 보기를 선택하세요.",
    };
  }
  const value = operationResultRecord(content);
  if (!value) return { kind: "code", content };
  if (toolName === "run_command") return commandOutput(value);
  if (isBasicFileTool(toolName)) return basicFileOutput(toolName, value);
  if (typeof value.ok === "boolean") {
    return {
      kind: "summary",
      content: value.ok ? "작업을 완료했습니다." : "작업을 완료하지 못했습니다.",
    };
  }
  return { kind: "summary", content: "도구 결과를 확인했습니다." };
}

function commandOutput(value: Record<string, unknown>): OperationOutputPresentation {
  const timedOut = value.timed_out === true;
  const exitCode = typeof value.exit_code === "number" ? value.exit_code : undefined;
  const succeeded = value.ok === true && !timedOut && (exitCode === undefined || exitCode === 0);
  const summary = timedOut
    ? "명령 실행 시간이 초과되었습니다."
    : `${succeeded ? "명령 완료" : "명령 실패"}${
      exitCode === undefined ? "" : ` · 종료 코드 ${exitCode}`
    }`;
  const stdout = stringValue(value.stdout);
  const stderr = stringValue(value.stderr);
  const output = commandText(stdout, stderr);
  return output ? { kind: "command", summary, content: output } : { kind: "command", summary };
}

function commandText(stdout: string, stderr: string): string {
  if (stdout && stderr) return `출력\n${stdout}\n\n오류 출력\n${stderr}`;
  return stdout || stderr;
}

function basicFileOutput(
  toolName: "edit_file" | "write_file" | "read_file",
  value: Record<string, unknown>,
): OperationOutputPresentation {
  if (value.ok !== true) {
    return { kind: "summary", content: "파일 작업을 완료하지 못했습니다." };
  }
  if (toolName === "read_file" && typeof value.content === "string") {
    return { kind: "code", content: value.content };
  }
  const fileName = operationFileName(value.path);
  if (!fileName) return { kind: "summary", content: "파일 작업을 완료했습니다." };
  const action = toolName === "edit_file" ? "수정 완료" : "작성 완료";
  const byteLabel = typeof value.bytes === "number"
    ? ` · ${new Intl.NumberFormat("ko-KR").format(value.bytes)}바이트`
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
