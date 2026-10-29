/**
 * W3C trace context for user actions (send, stop, model pick, retry): the App
 * request and the agent work it starts join one trace. Only requests to the
 * agent carry it; the agent strips it from every outbound request.
 */
const TRACED_ACTIONS: ReadonlyArray<readonly [string, RegExp]> = [
  ["POST", /^\/messages$/u],
  ["POST", /^\/session-queue$/u],
  ["POST", /^\/session-queue\/[^/]+\/send-now$/u],
  ["POST", /^\/turns\/[^/]+\/(?:retry|retry-current|cancel)$/u],
  ["PATCH", /^\/sessions\/[^/]+\/controls$/u],
];

const VALID = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/u;

export function isTracedAction(method: string, pathname: string): boolean {
  const upper = method.toUpperCase();
  return TRACED_ACTIONS.some(([verb, path]) => verb === upper && path.test(pathname));
}

export function isValidTraceparent(value: unknown): value is string {
  return typeof value === "string" && VALID.test(value);
}

/** `00-<trace id>-<parent id>-01`: random, lowercase, never all zeros. */
export function newTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

function randomHex(bytes: number): string {
  for (;;) {
    const values = crypto.getRandomValues(new Uint8Array(bytes));
    if (values.some((value) => value !== 0)) {
      return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
    }
  }
}

/**
 * The request's options with a fresh `traceparent` header when it is a user
 * action sent to the agent (a same-origin path), else the options unchanged.
 */
export function withActionTrace<T extends { method?: string; headers?: HeadersInit }>(path: string, options: T): T {
  if (typeof window === "undefined") return options;
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin || !isTracedAction(options.method ?? "GET", url.pathname)) return options;
  return { ...options, headers: { ...headerRecord(options.headers), traceparent: newTraceparent() } };
}

/** The traceparent a request carries, for the desktop bridge to forward. */
export function requestTraceparent(headers: HeadersInit | undefined): string | undefined {
  const value = headerRecord(headers).traceparent;
  return isValidTraceparent(value) ? value : undefined;
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}
