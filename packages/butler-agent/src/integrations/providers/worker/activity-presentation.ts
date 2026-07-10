import type { RuntimeMessageLanguage } from "../../../agent/output/messages.ts";
import { WORKER_ACTIVITY_HEARTBEAT_MS } from "../openai/runtime.ts";
import { formatWorkerActivityElapsed, type WorkerActivityHandler, type WorkerActivityPhase, type WorkerActivityUpdate } from "../runtime-contracts.ts";
import { homedir } from "os";




export function workerReportingTitle(language: RuntimeMessageLanguage): string {
  return language === "ko" ? "워커 결과를 작성합니다." : "Composing the worker result.";
}




export function safeWorkerCommandInputLabel(command: string): string {
  const text = command.replace(/\s+/gu, " ").trim();
  if (!text) return "";
  const home = homedir();
  const normalized = text.startsWith(home) ? `~/${text.slice(home.length).replace(/^\/+/u, "")}` : text;
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}




export function safeActivityToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 80) || "command";
}




export function workerEvidenceStatusLineForCommand(command: string, elapsedMs: number): string {
  const subject = workerEvidenceSubject(command);
  if (elapsedMs <= 0) return `Consolidating: reviewing ${subject}.`;
  return `Consolidating: still reviewing ${subject} (${formatWorkerActivityElapsed(elapsedMs)}).`;
}




export function workerEvidenceSubject(command: string): string {
  const normalized = command.toLocaleLowerCase("en-US");
  const readableFiles = readableCommandFiles(command);
  if (readableFiles.length > 0) return formatWorkerEvidenceSubject(readableFiles);
  if (/\b(test|check|lint|typecheck|vitest|jest|playwright|tsc)\b/u.test(normalized)) {
    return "validation output";
  }
  if (/\bgit\s+(status|diff|show|log)\b/u.test(normalized)) return "workspace state";
  if (/\b(rg|grep)\b/u.test(normalized) && !/\brg\s+--files\b/u.test(normalized)) {
    return "search results";
  }
  if (/\b(find|ls|tree)\b/u.test(normalized) || /\brg\s+--files\b/u.test(normalized)) {
    return "the file list";
  }
  if (/\bwc\b/u.test(normalized)) return "file measurements";
  if (/\bpwd\b/u.test(normalized)) return "the working directory";
  return "worker evidence";
}




export function readableCommandFiles(command: string): string[] {
  const tokens = safeShellTokens(command);
  const readCommandIndex = tokens.findIndex((token) => /^(cat|nl|sed|head|tail)$/u.test(token));
  if (readCommandIndex < 0) return [];
  const files: string[] = [];
  for (const token of tokens.slice(readCommandIndex + 1)) {
    if (!token || token.startsWith("-")) continue;
    if (/\\[nrt]/u.test(token)) continue;
    if (/^\d+(?:,\d+)?[a-z]?$/iu.test(token)) continue;
    if (/^s[|/].+[|/][a-z]*$/iu.test(token)) continue;
    if (/^[|;&(){}[\]<>]$/u.test(token)) continue;
    if (/^(sort|head|tail|sed|awk|grep|rg|cat|nl|printf|echo|xargs|cut|uniq)$/u.test(token)) break;
    if (token.includes("=") && !token.includes("/") && !token.includes(".")) continue;
    const label = safePathLabel(token);
    if (label) files.push(label);
    if (files.length >= 3) break;
  }
  return [...new Set(files)];
}




export function safeShellTokens(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? "").trim());
  }
  return tokens.filter(Boolean);
}




export function safePathLabel(value: string): string | null {
  const withoutTrailingPunctuation = value.replace(/[,:;]+$/u, "");
  if (!looksLikePathToken(withoutTrailingPunctuation)) return null;
  const lastSegment = withoutTrailingPunctuation.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
  const cleaned = lastSegment.replace(/[^a-zA-Z0-9._@+-]/gu, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  if (!/[a-zA-Z0-9]/u.test(cleaned)) return null;
  return cleaned.slice(0, 80);
}




export function looksLikePathToken(value: string): boolean {
  if (/[\\/]/u.test(value) || value.includes(".")) return true;
  return /^(README|LICENSE|CHANGELOG|Dockerfile|Makefile|Gemfile|Podfile)$/iu.test(value);
}




export function formatWorkerEvidenceSubject(files: string[]): string {
  if (files.length === 1) return files[0]!;
  if (files.length === 2) return `${files[0]} and ${files[1]}`;
  return `${files[0]} and ${files.length - 1} more files`;
}




export async function reportWorkerActivity(
  handler: WorkerActivityHandler | undefined,
  update: WorkerActivityUpdate,
): Promise<void> {
  await handler?.(update);
}




export async function withWorkerActivityHeartbeat<T>(
  handler: WorkerActivityHandler | undefined,
  phase: WorkerActivityPhase,
  statusLine: (elapsedMs: number) => string,
  operation: () => Promise<T>,
  intervalMs = WORKER_ACTIVITY_HEARTBEAT_MS,
): Promise<T> {
  if (!handler) return await operation();
  const startedAt = Date.now();
  const timer = setInterval(() => {
    void reportWorkerActivity(handler, {
      phase,
      statusLine: statusLine(Date.now() - startedAt),
    }).catch(() => {});
  }, intervalMs);
  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}
