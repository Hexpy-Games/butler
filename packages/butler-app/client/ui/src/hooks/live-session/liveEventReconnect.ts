const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export const LIVE_EVENT_STABLE_CONNECTION_MS = 30_000;

export function liveEventReconnectDelayMs(consecutiveFailures: number): number {
  if (!Number.isFinite(consecutiveFailures)) return RECONNECT_MAX_DELAY_MS;
  const exponent = Math.min(5, Math.max(0, Math.floor(consecutiveFailures)));
  return Math.min(
    RECONNECT_BASE_DELAY_MS * (2 ** exponent),
    RECONNECT_MAX_DELAY_MS,
  );
}
