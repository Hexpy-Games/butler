import { GatewayError, readEnvelope } from "./envelope.ts";
import type { ByteReader, GatewayClient } from "./gateway.ts";
import { createSseParser } from "./sse.ts";

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
export const LIVE_OPEN_DEADLINE_MS = 30_000;
export const LIVE_SIGNAL_DEADLINE_MS = 45_000; // server heartbeat every 15 s
export const LIVE_STABLE_CONNECTION_MS = 30_000;

/** 1 s doubling to 30 s by consecutive failures (the web client's rule, moved here). */
export function reconnectDelayMs(consecutiveFailures: number): number {
  if (!Number.isFinite(consecutiveFailures)) return RECONNECT_MAX_DELAY_MS;
  const exponent = Math.min(5, Math.max(0, Math.floor(consecutiveFailures)));
  return Math.min(
    RECONNECT_BASE_DELAY_MS * (2 ** exponent),
    RECONNECT_MAX_DELAY_MS,
  );
}

/** The resume cursor after an event: the highest event id seen. */
export function nextCursor(cursor: number, id: unknown): number {
  const value = Number(id);
  return Number.isFinite(value) ? Math.max(cursor, value) : cursor;
}

export interface LiveEvent { id: number; type: string; payload?: Record<string, unknown>; [key: string]: unknown }
export interface LiveConnectionOptions {
  client: GatewayClient;
  cursor: number;
  onEvent(event: LiveEvent): void; // every event except heartbeats and stream.reconcile_required
  onReconcile(): void; // stream.reconcile_required: refetch every view
  onRecovered(): void; // first open after a loss: refetch every view
  onLostChange(lost: boolean): void; // only on change
  onError?(error: GatewayError): void; // a non-2xx answer to the live request, or a GatewayError thrown by the transport
}
export interface LiveConnection {
  readonly cursor: number;
  /** Reconnect now if the stream is lost (app foregrounded, network back). Resets backoff. */
  resume(): void;
  /** Drop the stream without retrying (app backgrounded, network gone). */
  pause(): void;
  close(): void;
}

export function connectLive(options: LiveConnectionOptions): LiveConnection {
  let cursor = options.cursor;
  let closed = false, paused = false, lost = false;
  let generation = 0, attempts = 0, failures = 0;
  let abort: { aborted: boolean } | undefined, reader: ByteReader | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined, stableTimer: ReturnType<typeof setTimeout> | undefined;
  const setLost = (value: boolean) => { if (lost !== value) { lost = value; options.onLostChange(value); } };
  const tearDown = () => {
    generation++;
    clearTimeout(retryTimer); clearTimeout(deadline); clearTimeout(stableTimer);
    retryTimer = deadline = stableTimer = undefined;
    if (abort) abort.aborted = true;
    void reader?.cancel().catch(() => {});
    reader = undefined;
  };
  const fail = () => {
    tearDown(); setLost(true);
    if (!paused && !closed) retryTimer = setTimeout(connect, reconnectDelayMs(failures++));
  };
  const connect = async () => {
    if (closed || paused) return;
    tearDown(); setLost(true);
    const current = generation, recovering = attempts++ > 0;
    const isCurrent = () => !closed && !paused && current === generation;
    const signal = { aborted: false };
    abort = signal;
    const disconnect = () => { if (isCurrent()) fail(); };
    deadline = setTimeout(disconnect, LIVE_OPEN_DEADLINE_MS);
    try {
      const response = await options.client.openLiveEvents(cursor, signal);
      if (!isCurrent()) return;
      if (!response.ok) {
        let error: GatewayError | undefined;
        try { readEnvelope(response.status, await response.json()); }
        catch (cause) { if (cause instanceof GatewayError) error = cause; }
        if (!isCurrent()) return;
        if (error) options.onError?.(error);
        disconnect(); return;
      }
      clearTimeout(deadline);
      deadline = setTimeout(disconnect, LIVE_SIGNAL_DEADLINE_MS);
      stableTimer = setTimeout(() => { if (isCurrent()) failures = 0; }, LIVE_STABLE_CONNECTION_MS);
      setLost(false);
      if (isCurrent() && recovering) options.onRecovered();
      if (!isCurrent()) return;
      const activeReader = response.body?.getReader();
      if (!activeReader) { disconnect(); return; }
      reader = activeReader;
      const parser = createSseParser(), decoder = new TextDecoder();
      while (isCurrent()) {
        const chunk = await activeReader.read();
        if (!isCurrent()) return;
        if (chunk.done) { disconnect(); return; }
        clearTimeout(deadline);
        deadline = setTimeout(disconnect, LIVE_SIGNAL_DEADLINE_MS);
        for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          if (!isCurrent()) return;
          if (frame.event === "heartbeat") continue;
          const event = JSON.parse(frame.data) as LiveEvent;
          cursor = nextCursor(cursor, event.id);
          if (event.type === "stream.reconcile_required") options.onReconcile();
          else options.onEvent(event);
        }
      }
    } catch (cause) {
      if (cause instanceof GatewayError && isCurrent()) options.onError?.(cause);
      disconnect();
    }
  };
  void connect();
  return {
    get cursor() { return cursor; },
    resume() {
      if (!closed && (lost || paused)) { paused = false; failures = 0; void connect(); }
    },
    pause() { if (!closed) { paused = true; tearDown(); setLost(true); } },
    close() { closed = true; tearDown(); },
  };
}
