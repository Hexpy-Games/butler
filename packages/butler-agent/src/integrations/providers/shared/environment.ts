import type { AttachmentRef } from "../../../test-support/harness/contracts.ts";
import { ModelProviderRequestError } from "../provider-errors.ts";
import { appendFileSync, existsSync, readFileSync } from "fs";
import { attachmentImageDataUrl, promptWithAttachmentContext } from "../../../agent/context/attachment-context.ts";
import { homedir } from "os";
import { join } from "path";


export const MAX_TOOL_ROUNDS = 60;


export const DEFAULT_MODEL_API_RETRY_ATTEMPTS = 3;


export const DEFAULT_MODEL_API_RETRY_DELAY_MS = 750;



export function readConfig(): Record<string, any> {
  const configPath = join(getButlerData(), "butler.config.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}



export function getButlerHome(): string {
  return process.env.BUTLER_HOME || process.cwd();
}



export function getButlerData(): string {
  return process.env.BUTLER_DATA || join(homedir(), ".butler");
}



export function openAIInputWithAttachments(prompt: string, attachments?: AttachmentRef[]): unknown {
  const imageParts = (attachments ?? [])
    .map((attachment) => attachmentImageDataUrl(attachment))
    .filter((url): url is string => Boolean(url))
    .map((imageUrl) => ({
      type: "input_image",
      image_url: imageUrl,
    }));
  const text = promptWithAttachmentContext(prompt, attachments);
  if (imageParts.length === 0) return text;
  return [{
    role: "user",
    content: [
      {
        type: "input_text",
        text,
      },
      ...imageParts,
    ],
  }];
}



export function localUserContentWithAttachments(prompt: string, attachments?: AttachmentRef[]): string | Array<Record<string, unknown>> {
  const imageParts = (attachments ?? [])
    .map((attachment) => attachmentImageDataUrl(attachment))
    .filter((url): url is string => Boolean(url))
    .map((url) => ({
      type: "image_url",
      image_url: { url },
    }));
  const text = promptWithAttachmentContext(prompt, attachments);
  if (imageParts.length === 0) return text;
  return [
    {
      type: "text",
      text,
    },
    ...imageParts,
  ];
}



export function modelApiRetryAttempts(): number {
  const raw = Number(process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS);
  if (!Number.isFinite(raw)) return DEFAULT_MODEL_API_RETRY_ATTEMPTS;
  return Math.max(1, Math.min(5, Math.trunc(raw)));
}




export function workerTracePath(taskDir: string | undefined): string | null {
  return taskDir ? join(taskDir, "worker_observability.jsonl") : null;
}



export function compactTraceValue(input: unknown, max = 800): unknown {
  if (typeof input === "string") return input.replace(/\s+/g, " ").trim().slice(0, max);
  if (input === null || input === undefined) return input;
  try {
    const text = JSON.stringify(input);
    return text.length > max ? `${text.slice(0, max)}…` : input;
  } catch {
    return String(input).slice(0, max);
  }
}



export function writeWorkerTrace(taskDir: string | undefined, event: string, data: Record<string, unknown> = {}): void {
  const path = workerTracePath(taskDir);
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`, "utf8");
  } catch {
    // Observability is best-effort; provider execution remains primary.
  }
}



export function modelApiRetryDelayMs(attemptIndex: number): number {
  const raw = Number(process.env.BUTLER_MODEL_API_RETRY_DELAY_MS);
  const base = Number.isFinite(raw) ? Math.max(0, raw) : DEFAULT_MODEL_API_RETRY_DELAY_MS;
  return Math.min(5_000, base * 2 ** Math.max(0, attemptIndex));
}



export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}



export function abortError(): Error {
  const error = new Error("Runtime turn was cancelled.");
  error.name = "AbortError";
  return error;
}



export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}



export function isTransientModelApiError(error: unknown): boolean {
  if (error instanceof ModelProviderRequestError) return error.retryable;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:OpenAI Responses API error|Codex backend error) \((?:429|5\d\d)\)/i.test(message) ||
    /\bserver_error\b/i.test(message) ||
    /upstream connect error|disconnect\/reset|connection termination|ECONNRESET|ETIMEDOUT|ECONNRESET|fetch failed/i
      .test(message);
}



export async function withModelApiRetry<T>(
  operation: (attempt: number) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const attempts = modelApiRetryAttempts();
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      throwIfAborted(signal);
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw abortError();
      const retryable = isTransientModelApiError(error) && !(
        error instanceof ModelProviderRequestError &&
        error.code === "provider_context_limit_exceeded"
      );
      if (attempt >= attempts - 1 || !retryable) throw error;
      await sleep(modelApiRetryDelayMs(attempt), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
