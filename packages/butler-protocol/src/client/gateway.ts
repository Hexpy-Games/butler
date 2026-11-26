import { readEnvelope } from "./envelope.ts";

export interface AbortSignalLike { readonly aborted: boolean }
export interface ByteReader { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }
export interface ResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly body: { getReader(): ByteReader } | null;
  json(): Promise<unknown>;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignalLike }) => Promise<ResponseLike>;
export interface GatewayClientOptions { origin: string; fetch: FetchLike; token?: () => string | undefined }
export interface GatewayClient {
  /** JSON request; resolves to the envelope's data. Throws GatewayError. */
  request<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignalLike }): Promise<T>;
  /** Opens GET /events/live?cursor=<n> as a byte stream (Accept: text/event-stream). */
  openLiveEvents(cursor: number, signal: AbortSignalLike): Promise<ResponseLike>;
}

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  const origin = options.origin.replace(/\/$/, "");
  return {
    async request<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignalLike } = {}): Promise<T> {
      const headers: Record<string, string> = { accept: "application/json" };
      const token = options.token?.();
      if (token) headers.Authorization = `Bearer ${token}`;
      if (init.body !== undefined) headers["content-type"] = "application/json";
      const response = await options.fetch(origin + path, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal,
      });
      if (response.status === 204) return undefined as T;
      const body = await response.json().catch(() => null);
      return readEnvelope<T>(response.status, body);
    },
    openLiveEvents(cursor, signal) {
      const headers: Record<string, string> = { accept: "text/event-stream" };
      const token = options.token?.();
      if (token) headers.Authorization = `Bearer ${token}`;
      return options.fetch(`${origin}/events/live?cursor=${cursor}`, { method: "GET", headers, signal });
    },
  };
}
