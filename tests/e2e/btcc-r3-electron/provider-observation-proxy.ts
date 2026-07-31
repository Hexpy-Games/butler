import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { type AddressInfo, type Socket } from "node:net";
import { pipeline, Transform } from "node:stream";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_RESPONSES_PATH = "/codex/responses";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type ProviderRequestKind = "main" | "title";
export type ProviderRequestTermination =
  | "cancelled"
  | "completed"
  | "failed";

export interface ProviderRequestObservation {
  ordinal: number;
  requestKind: ProviderRequestKind;
  requestStartedAtMs: number;
  serializedRequestBytes: number;
  firstContentBearingDeltaAtMs: number | null;
  completedAtMs: number | null;
  terminatedAtMs: number | null;
  termination: ProviderRequestTermination | null;
  status: number | null;
  hasTextContent: boolean;
  hasToolArgumentContent: boolean;
  hasReasoningContent: boolean;
}

interface MutableProviderRequestObservation extends ProviderRequestObservation {}

export interface ProviderObservationProxy {
  endpoint: string;
  observations(): ProviderRequestObservation[];
  close(): Promise<ProviderRequestObservation[]>;
}

export interface ProviderObservationProxyOptions {
  upstreamBaseUrl?: string;
  now?: () => number;
}

interface ContentObservation {
  firstDelta: boolean;
  reasoning: boolean;
  text: boolean;
  toolArguments: boolean;
}

function codexResponsesUrl(baseUrl: string | undefined): URL {
  const base = (baseUrl?.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/u, "");
  if (base.endsWith(CODEX_RESPONSES_PATH)) return new URL(base);
  if (base.endsWith("/codex")) return new URL(`${base}/responses`);
  return new URL(`${base}${CODEX_RESPONSES_PATH}`);
}

function isTitleRequest(body: Buffer): boolean {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as {
      prompt_cache_key?: unknown;
    };
    return typeof parsed.prompt_cache_key === "string" &&
      parsed.prompt_cache_key.split(":").at(-1) ===
        "native-butler-title-provider";
  } catch {
    return false;
  }
}

function safeObservation(
  observation: MutableProviderRequestObservation,
): ProviderRequestObservation {
  return {
    ordinal: observation.ordinal,
    requestKind: observation.requestKind,
    requestStartedAtMs: observation.requestStartedAtMs,
    serializedRequestBytes: observation.serializedRequestBytes,
    firstContentBearingDeltaAtMs:
      observation.firstContentBearingDeltaAtMs,
    completedAtMs: observation.completedAtMs,
    terminatedAtMs: observation.terminatedAtMs,
    termination: observation.termination,
    status: observation.status,
    hasTextContent: observation.hasTextContent,
    hasToolArgumentContent: observation.hasToolArgumentContent,
    hasReasoningContent: observation.hasReasoningContent,
  };
}

function forwardedRequestHeaders(
  headers: IncomingHttpHeaders,
): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value === undefined) {
      continue;
    }
    forwarded[name] = value;
  }
  // The observer must see the provider's SSE frames. Asking for identity keeps
  // the response byte-stream parseable without buffering or retaining content.
  forwarded["accept-encoding"] = "identity";
  return forwarded;
}

function forwardedResponseHeaders(
  headers: IncomingHttpHeaders,
): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value === undefined) {
      continue;
    }
    forwarded[name] = value;
  }
  return forwarded;
}

function nextFrameBoundary(
  buffer: string,
): { index: number; length: number } | null {
  const candidates = [
    { index: buffer.indexOf("\r\n\r\n"), length: 4 },
    { index: buffer.indexOf("\n\n"), length: 2 },
    { index: buffer.indexOf("\r\r"), length: 2 },
  ].filter((candidate) => candidate.index >= 0);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) =>
    candidate.index < best.index ? candidate : best,
  );
}

function sseEventFromFrame(frame: string): Record<string, unknown> | null {
  const data = frame
    .split(/\r\n|\n|\r/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function outputItemContent(event: Record<string, unknown>): ContentObservation {
  const empty: ContentObservation = {
    firstDelta: false,
    reasoning: false,
    text: false,
    toolArguments: false,
  };
  if (
    event.type !== "response.output_item.done" ||
    !event.item ||
    typeof event.item !== "object"
  ) {
    return empty;
  }
  const item = event.item as Record<string, unknown>;
  if (item.type === "function_call") {
    return {
      ...empty,
      toolArguments: nonEmptyString(item.arguments),
    };
  }
  if (item.type === "reasoning") {
    return {
      ...empty,
      reasoning: true,
    };
  }
  if (
    (item.type === "output_text" || item.type === "text") &&
    nonEmptyString(item.text)
  ) {
    return {
      ...empty,
      text: true,
    };
  }
  if (item.type !== "message" || !Array.isArray(item.content)) return empty;
  const hasText = item.content.some((part) =>
    part &&
    typeof part === "object" &&
    (
      (part as Record<string, unknown>).type === "output_text" ||
      (part as Record<string, unknown>).type === "text"
    ) &&
    nonEmptyString((part as Record<string, unknown>).text),
  );
  return {
    ...empty,
    text: hasText,
  };
}

function completedResponseContent(
  event: Record<string, unknown>,
): ContentObservation {
  const empty: ContentObservation = {
    firstDelta: false,
    reasoning: false,
    text: false,
    toolArguments: false,
  };
  if (
    event.type !== "response.completed" ||
    !event.response ||
    typeof event.response !== "object"
  ) {
    return empty;
  }
  const response = event.response as Record<string, unknown>;
  if (!Array.isArray(response.output)) return empty;
  return response.output.reduce<ContentObservation>((combined, item) => {
    const observed = outputItemContent({
      type: "response.output_item.done",
      item,
    });
    return {
      firstDelta: false,
      reasoning: combined.reasoning || observed.reasoning,
      text: combined.text || observed.text,
      toolArguments: combined.toolArguments || observed.toolArguments,
    };
  }, empty);
}

function contentObservation(
  event: Record<string, unknown>,
): ContentObservation {
  const type = typeof event.type === "string" ? event.type : "";
  const hasDelta = nonEmptyString(event.delta);
  if (type === "response.output_text.delta" && hasDelta) {
    return {
      firstDelta: true,
      reasoning: false,
      text: true,
      toolArguments: false,
    };
  }
  if (
    hasDelta &&
    /(?:^|\.)reasoning(?:_summary)?(?:_text)?\.delta$/u.test(type)
  ) {
    return {
      firstDelta: true,
      reasoning: true,
      text: false,
      toolArguments: false,
    };
  }
  if (type === "response.function_call_arguments.delta" && hasDelta) {
    return {
      firstDelta: true,
      reasoning: false,
      text: false,
      toolArguments: true,
    };
  }
  if (type === "response.output_text.done" && nonEmptyString(event.text)) {
    return {
      firstDelta: false,
      reasoning: false,
      text: true,
      toolArguments: false,
    };
  }
  const outputItem = outputItemContent(event);
  if (
    outputItem.text ||
    outputItem.reasoning ||
    outputItem.toolArguments
  ) {
    return outputItem;
  }
  return completedResponseContent(event);
}

class SseObservationTransform extends Transform {
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #providerFailed = false;

  constructor(
    private readonly observation: MutableProviderRequestObservation,
    private readonly now: () => number,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.#observeText(this.#decoder.decode(chunk, { stream: true }));
    callback(null, chunk);
  }

  override _flush(callback: (error?: Error | null) => void): void {
    this.#observeText(this.#decoder.decode());
    if (this.#buffer.trim()) this.#observeFrame(this.#buffer);
    this.#buffer = "";
    callback();
  }

  providerFailed(): boolean {
    return this.#providerFailed;
  }

  #observeText(text: string): void {
    this.#buffer += text;
    while (true) {
      const boundary = nextFrameBoundary(this.#buffer);
      if (!boundary) return;
      const frame = this.#buffer.slice(0, boundary.index);
      this.#buffer = this.#buffer.slice(boundary.index + boundary.length);
      this.#observeFrame(frame);
    }
  }

  #observeFrame(frame: string): void {
    const event = sseEventFromFrame(frame);
    if (!event) return;
    if (
      event.type === "response.failed" ||
      event.type === "response.incomplete" ||
      event.type === "response.cancelled" ||
      event.type === "error"
    ) {
      this.#providerFailed = true;
    }
    const content = contentObservation(event);
    this.observation.hasTextContent ||= content.text;
    this.observation.hasToolArgumentContent ||= content.toolArguments;
    this.observation.hasReasoningContent ||= content.reasoning;
    if (
      content.firstDelta &&
      this.observation.firstContentBearingDeltaAtMs === null
    ) {
      this.observation.firstContentBearingDeltaAtMs = this.now();
    }
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function terminateObservation(
  observation: MutableProviderRequestObservation,
  termination: ProviderRequestTermination,
  now: () => number,
): void {
  if (observation.termination !== null) return;
  const terminatedAtMs = now();
  observation.termination = termination;
  observation.terminatedAtMs = terminatedAtMs;
  if (termination === "completed") observation.completedAtMs = terminatedAtMs;
}

function sendProxyFailure(response: ServerResponse): void {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(502, {
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("Provider observation proxy could not reach the upstream provider.");
}

async function forwardRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  upstream: URL;
  observation: MutableProviderRequestObservation;
  now: () => number;
  activeUpstreamRequests: Set<ClientRequest>;
  activeUpstreamResponses: Set<IncomingMessage>;
  isClosing: () => boolean;
}): Promise<void> {
  const {
    request,
    response,
    upstream,
    observation,
    now,
    activeUpstreamRequests,
    activeUpstreamResponses,
    isClosing,
  } = input;
  const body = await readRequestBody(request);
  observation.serializedRequestBytes = body.byteLength;
  observation.requestKind = isTitleRequest(body) ? "title" : "main";
  if (isClosing() || response.destroyed) {
    terminateObservation(observation, "cancelled", now);
    response.destroy();
    return;
  }

  await new Promise<void>((resolve) => {
    const requestUpstream = upstream.protocol === "https:"
      ? httpsRequest
      : httpRequest;
    const upstreamRequest = requestUpstream(upstream, {
      method: request.method,
      headers: forwardedRequestHeaders(request.headers),
    });
    let upstreamResponseForClient: IncomingMessage | null = null;
    let observationStream: SseObservationTransform | null = null;
    let downstreamCancelled = false;
    let upstreamFailed = false;
    let settled = false;
    const settle = (termination: ProviderRequestTermination): void => {
      if (settled) return;
      settled = true;
      terminateObservation(observation, termination, now);
      resolve();
    };
    const propagateUpstreamFailure = (): void => {
      if (downstreamCancelled || isClosing()) return;
      upstreamFailed = true;
      const failure = new Error("provider_observation_upstream_stream_failed");
      observationStream?.destroy(failure);
      if (!response.destroyed) response.destroy(failure);
    };

    const cancelDownstream = (): void => {
      if (response.writableFinished) return;
      downstreamCancelled = true;
      upstreamResponseForClient?.destroy();
      observationStream?.destroy(
        new Error("provider_observation_downstream_cancelled"),
      );
      upstreamRequest.destroy();
      settle(upstreamFailed ? "failed" : "cancelled");
    };
    activeUpstreamRequests.add(upstreamRequest);
    response.once("close", cancelDownstream);
    request.once("aborted", cancelDownstream);
    upstreamRequest.once("close", () => {
      activeUpstreamRequests.delete(upstreamRequest);
    });
    upstreamRequest.once("error", () => {
      activeUpstreamRequests.delete(upstreamRequest);
      if (upstreamResponseForClient !== null) {
        propagateUpstreamFailure();
        return;
      }
      settle(isClosing() || downstreamCancelled ? "cancelled" : "failed");
      sendProxyFailure(response);
    });
    upstreamRequest.once("response", (upstreamResponse) => {
      upstreamResponseForClient = upstreamResponse;
      activeUpstreamRequests.delete(upstreamRequest);
      activeUpstreamResponses.add(upstreamResponse);
      observation.status = upstreamResponse.statusCode ?? null;
      if (isClosing() || response.destroyed) {
        settle("cancelled");
        upstreamResponse.destroy();
        return;
      }
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        forwardedResponseHeaders(upstreamResponse.headers),
      );
      // Codex response bodies use SSE framing even when an intermediary omits or
      // rewrites Content-Type. Parsing every byte stream is safe: non-SSE bodies
      // have no `data:` frames and still pass through unchanged.
      const stream = new SseObservationTransform(observation, now);
      observationStream = stream;
      upstreamResponse.once("aborted", propagateUpstreamFailure);
      upstreamResponse.once("error", propagateUpstreamFailure);
      upstreamResponse.once("close", () => {
        activeUpstreamResponses.delete(upstreamResponse);
      });
      pipeline(upstreamResponse, stream, response, (error) => {
        activeUpstreamResponses.delete(upstreamResponse);
        if (error) {
          settle(
            isClosing() || (!upstreamFailed && downstreamCancelled)
              ? "cancelled"
              : "failed",
          );
          if (!response.destroyed) response.destroy(error);
          return;
        }
        const status = observation.status;
        settle(
          stream.providerFailed() || status === null ||
              status < 200 || status >= 300
            ? "failed"
            : "completed",
        );
      });
    });
    upstreamRequest.end(body);
  });
}

async function closeServer(
  server: Server,
  inboundSockets: Set<Socket>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    for (const socket of inboundSockets) socket.destroy();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

export async function startProviderObservationProxy(
  options: ProviderObservationProxyOptions = {},
): Promise<ProviderObservationProxy> {
  const upstream = codexResponsesUrl(options.upstreamBaseUrl);
  const now = options.now ?? Date.now;
  const observed: MutableProviderRequestObservation[] = [];
  const activeInboundRequests = new Set<IncomingMessage>();
  const activeDownstreamResponses = new Set<ServerResponse>();
  const activeUpstreamRequests = new Set<ClientRequest>();
  const activeUpstreamResponses = new Set<IncomingMessage>();
  const activeForwards = new Set<Promise<void>>();
  const inboundSockets = new Set<Socket>();
  let nextOrdinal = 1;
  let closing = false;
  const server = createServer((request, response) => {
    if (closing) {
      request.destroy();
      response.destroy();
      return;
    }
    const pathname = new URL(
      request.url ?? "/",
      "http://provider-observation.invalid",
    ).pathname;
    if (pathname !== CODEX_RESPONSES_PATH) {
      response.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("Not found.");
      return;
    }
    const observation: MutableProviderRequestObservation = {
      ordinal: nextOrdinal,
      requestKind: "main",
      requestStartedAtMs: now(),
      serializedRequestBytes: 0,
      firstContentBearingDeltaAtMs: null,
      completedAtMs: null,
      terminatedAtMs: null,
      termination: null,
      status: null,
      hasTextContent: false,
      hasToolArgumentContent: false,
      hasReasoningContent: false,
    };
    nextOrdinal += 1;
    observed.push(observation);
    activeInboundRequests.add(request);
    activeDownstreamResponses.add(response);
    request.once("close", () => activeInboundRequests.delete(request));
    const releaseDownstream = () => {
      activeDownstreamResponses.delete(response);
    };
    response.once("close", releaseDownstream);
    response.once("finish", releaseDownstream);
    const forwarding = forwardRequest({
      request,
      response,
      upstream,
      observation,
      now,
      activeUpstreamRequests,
      activeUpstreamResponses,
      isClosing: () => closing,
    }).catch(() => {
      terminateObservation(
        observation,
        closing || request.aborted || response.destroyed
          ? "cancelled"
          : "failed",
        now,
      );
      sendProxyFailure(response);
    });
    activeForwards.add(forwarding);
    void forwarding.then(() => activeForwards.delete(forwarding));
  });
  server.on("connection", (socket) => {
    inboundSockets.add(socket);
    socket.once("close", () => inboundSockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address() as AddressInfo;
  let closePromise: Promise<void> | null = null;
  return {
    endpoint: `http://127.0.0.1:${address.port}${CODEX_RESPONSES_PATH}`,
    observations: () => observed.map(safeObservation),
    close: async () => {
      if (!closePromise) {
        closing = true;
        closePromise = (async () => {
          const serverClosed = closeServer(server, inboundSockets);
          for (const response of [...activeDownstreamResponses]) {
            response.destroy();
          }
          for (const request of [...activeInboundRequests]) request.destroy();
          for (const response of [...activeUpstreamResponses]) response.destroy();
          for (const request of [...activeUpstreamRequests]) request.destroy();
          await Promise.allSettled([...activeForwards]);
          await serverClosed;
          for (const observation of observed) {
            if (observation.termination === null) {
              terminateObservation(observation, "cancelled", now);
            }
          }
        })();
      }
      await closePromise;
      return observed.map(safeObservation);
    },
  };
}
