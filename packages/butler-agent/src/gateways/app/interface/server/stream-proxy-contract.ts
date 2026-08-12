export interface StreamProxyStats {
  upstreamReaderActive: boolean;
  listenerCount: number;
  pendingChunks: number;
}

export interface StreamProxyHandle<T> {
  stream: ReadableStream<T>;
  close(): Promise<void>;
  stats(): StreamProxyStats;
}

export interface StreamProxyOptions<T> {
  upstream: ReadableStream<T>;
  maxBufferedChunks?: number;
  overflowChunk?: () => T | undefined;
  clientDisconnectSignal?: AbortSignal;
  serverShutdownSignal?: AbortSignal;
}

export interface PushStreamProxyOptions<T> {
  maxBufferedChunks?: number;
  overflowChunk?: () => T | undefined;
  clientDisconnectSignal?: AbortSignal;
  serverShutdownSignal?: AbortSignal;
  onCancel?: () => void | Promise<void>;
}

export interface PushStreamProxyHandle<T> extends StreamProxyHandle<T> {
  /** Push one producer item; the bridge owns all downstream buffering. */
  push(chunk: T): void;
}

export const DEFAULT_MAX_BUFFERED_CHUNKS = 128;

export function boundedBufferSize(value: number | undefined): number {
  const candidate = Number(value);
  return Number.isFinite(candidate)
    ? Math.max(1, Math.min(2_000, Math.floor(candidate)))
    : DEFAULT_MAX_BUFFERED_CHUNKS;
}
