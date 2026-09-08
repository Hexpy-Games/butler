import { appCopy } from "@/app/copy.ts";
import { presentReadOperation } from "./operationReadOutputPresentation";
import { presentStructuredOperation } from "./operationStructuredOutputPresentation";

export type OperationOutputSection = { title: string; content?: string; message?: string };

export type OperationOutputPresentation =
  | { kind: "code"; content: string }
  | { kind: "summary"; content: string }
  | { kind: "command"; summary: string; content?: string }
  | { kind: "sections"; summary: string; sections: OperationOutputSection[] };

export function presentOperationOutput(
  toolName: string | undefined,
  content: string,
  complete: boolean,
): OperationOutputPresentation {
  if (!complete) {
    return {
      kind: "summary",
      content: appCopy.interfaceStatus.partialOutput,
    };
  }
  const value = operationResultRecord(content);
  if (!value) return { kind: "code", content };
  if (toolName === "run_command") return commandOutput(value);
  const readOutput = presentReadOperation(toolName, value);
  if (readOutput) return readOutput;
  if (value.ok === false || value.pending === true || value.authority_pending === true) {
    const failure = presentStructuredOperation(value);
    if (failure) return failure;
  }
  if (isBasicFileTool(toolName)) return basicFileOutput(toolName, value);
  const structured = presentStructuredOperation(value);
  if (structured) return structured;
  if (typeof value.ok === "boolean") {
    return {
      kind: "summary",
      content: value.ok ? appCopy.interfaceStatus.noDetailSupport : appCopy.interfaceStatus.operationFailed,
    };
  }
  return { kind: "summary", content: appCopy.interfaceStatus.resultChecked };
}

function commandOutput(value: Record<string, unknown>): OperationOutputPresentation {
  const timedOut = value.timed_out === true;
  const exitCode = typeof value.exit_code === "number" ? value.exit_code : undefined;
  const succeeded = value.ok === true && !timedOut && (exitCode === undefined || exitCode === 0);
  const summary = timedOut
    ? appCopy.interfaceStatus.commandTimeout
    : `${succeeded ? appCopy.interfaceStatus.commandDone : appCopy.interfaceStatus.commandFailed}${
      exitCode === undefined ? "" : ` · ${appCopy.interfaceStatus.exitCode(exitCode)}`
    }`;
  const stdout = stringValue(value.stdout);
  const stderr = stringValue(value.stderr);
  const output = commandText(stdout, stderr);
  return output ? { kind: "command", summary, content: output } : { kind: "command", summary };
}

function commandText(stdout: string, stderr: string): string {
  if (stdout && stderr) return appCopy.interfaceStatus.commandStreams(stdout, stderr);
  return stdout || stderr;
}

function basicFileOutput(
  toolName: "edit_file" | "write_file" | "read_file",
  value: Record<string, unknown>,
): OperationOutputPresentation {
  if (value.ok !== true) {
    return { kind: "summary", content: appCopy.interfaceStatus.fileFailed };
  }
  if (toolName === "read_file" && typeof value.content === "string") {
    return { kind: "code", content: value.content };
  }
  const fileName = operationFileName(value.path);
  if (!fileName) return { kind: "summary", content: appCopy.interfaceStatus.fileDone };
  const action = toolName === "edit_file" ? appCopy.interfaceStatus.editDone : appCopy.interfaceStatus.writeDone;
  const byteLabel = typeof value.bytes === "number"
    ? ` · ${appCopy.interfaceStatus.bytes(value.bytes)}`
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
