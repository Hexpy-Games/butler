import {
  accumulateProviderEvent,
  completedResponse,
  createAccumulator,
  parseProviderEvent,
  HostedChatStreamProtocolError,
} from "./hosted-chat-stream-state.ts";

export {
  HostedChatStreamProtocolError,
  HostedChatStreamProviderError,
} from "./hosted-chat-stream-state.ts";

// A provider must delimit SSE frames; retaining an unframed response until EOF
// would otherwise let one malformed body grow the reader's memory without
// bound. This is deliberately larger than normal tool-call/event payloads but
// still keeps the provider boundary finite.
export const MAX_HOSTED_CHAT_SSE_FRAME_BYTES = 8 * 1024 * 1024;

export function isHostedChatSseResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase()
    .includes("text/event-stream") ?? false;
}

export async function readHostedChatSseResponse(
  response: Response,
  onValidEvent: () => void,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  if (!response.body) {
    throw new HostedChatStreamProtocolError(
      "Hosted Chat Completions stream has no response body",
    );
  }
  const state = createAccumulator();
  let completed = false;
  await consumeSseBody(response.body, (data) => {
    if (data === "[DONE]") {
      completed = true;
      onValidEvent();
      return;
    }
    const event = parseProviderEvent(data);
    onValidEvent();
    accumulateProviderEvent(state, event);
  }, signal);
  if (!completed) {
    throw new HostedChatStreamProtocolError(
      "Hosted Chat Completions stream ended before its terminator",
    );
  }
  return completedResponse(state);
}

async function consumeSseBody(
  body: ReadableStream<Uint8Array>,
  consumeData: (data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        rejectAbort = reject;
      })
    : null;
  const onAbort = (): void => {
    rejectAbort?.(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
  };
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const read = abortPromise
        ? await Promise.race([reader.read(), abortPromise])
        : await reader.read();
      const { value, done } = read;
      if (!done && (!value || value.byteLength === 0)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        continue;
      }
      buffer += decoder.decode(value, { stream: !done });
      while (true) {
        const boundary = nextFrameBoundary(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        if (Buffer.byteLength(frame, "utf8") > MAX_HOSTED_CHAT_SSE_FRAME_BYTES) {
          throw new HostedChatStreamProtocolError(
            `Hosted Chat Completions SSE frame exceeded ${MAX_HOSTED_CHAT_SSE_FRAME_BYTES} bytes`,
          );
        }
        consumeFrame(frame, consumeData);
        buffer = buffer.slice(boundary.index + boundary.length);
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_HOSTED_CHAT_SSE_FRAME_BYTES) {
        throw new HostedChatStreamProtocolError(
          `Hosted Chat Completions SSE frame exceeded ${MAX_HOSTED_CHAT_SSE_FRAME_BYTES} bytes`,
        );
      }
      if (done) break;
    }
    if (buffer.trim()) {
      if (Buffer.byteLength(buffer, "utf8") > MAX_HOSTED_CHAT_SSE_FRAME_BYTES) {
        throw new HostedChatStreamProtocolError(
          `Hosted Chat Completions SSE frame exceeded ${MAX_HOSTED_CHAT_SSE_FRAME_BYTES} bytes`,
        );
      }
      consumeFrame(buffer, consumeData);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // A reader that ended normally is already drained; cancel is harmless and
    // makes provider implementations release any response-body bookkeeping.
    try {
      await reader.cancel();
    } catch {
      // Preserve the primary provider/protocol/abort error.
    }
    try {
      reader.releaseLock();
    } catch {
      // The stream may have released its lock while closing.
    }
  }
}

function consumeFrame(frame: string, consumeData: (data: string) => void): void {
  const data = frame
    .split(/\r?\n|\r/gu)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (data) consumeData(data);
}

function nextFrameBoundary(buffer: string): { index: number; length: number } | null {
  const candidates = [
    { index: buffer.indexOf("\r\n\r\n"), length: 4 },
    { index: buffer.indexOf("\n\n"), length: 2 },
    { index: buffer.indexOf("\r\r"), length: 2 },
  ].filter((candidate) => candidate.index >= 0);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) => candidate.index < best.index ? candidate : best);
}
