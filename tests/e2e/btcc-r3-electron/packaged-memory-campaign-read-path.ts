import type { AppSessionView } from "./contracts.ts";
import type { ProductLaunch } from "./product-launch.ts";
import type { CdpPage } from "./cdp-page.ts";
import { CampaignFailure } from "./packaged-memory-campaign-contracts.ts";
import type { SessionViewBridgeError } from "../../../packages/butler-app/client/ui/src/app/types.ts";

const SAFE_PRODUCT_API_CODE = /^[a-z][a-z0-9_]{1,63}$/u;
const BRIDGE_ERROR_SCHEMA = "butler.app.bridge-error.v1" as const;
const PUBLIC_READ_PATH_TEARDOWN_SETTLE_MS = 120;

export class ProductCallFailure extends Error {
  readonly apiCode: string;
  readonly status?: number;
  readonly resyncRequired: boolean;
  readonly resync?: SessionViewBridgeError["resync"];

  constructor(
    apiCode: string,
    status?: number,
    resync?: SessionViewBridgeError["resync"],
  ) {
    super("Public product call failed.");
    this.name = "ProductCallFailure";
    this.apiCode = apiCode;
    this.status = status;
    this.resync = resync;
    this.resyncRequired = resync?.required === true;
  }
}

export type PublicReadPathStep =
  | "initial-view"
  | "delta-refresh"
  | "cursor-resync"
  | "before-cursor-page"
  | "transcript-export"
  | "event-replay"
  | "usage-health"
  | "sse-reconnect";

export class PublicReadPathFailure extends CampaignFailure {
  readonly step: PublicReadPathStep;
  readonly apiCode: string;

  constructor(step: PublicReadPathStep, apiCode: string) {
    super("campaign_public_read_failed", `step=${step};api=${apiCode}`);
    this.name = "PublicReadPathFailure";
    this.step = step;
    this.apiCode = apiCode;
  }
}

export function normalizeProductApiCode(value: unknown): string {
  return typeof value === "string" && SAFE_PRODUCT_API_CODE.test(value)
    ? value
    : "request_failed";
}

export function decodeProductCallEnvelope<T>(value: unknown):
  | { ok: true; value: T }
  | { ok: false; error: SessionViewBridgeError } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: { schema: BRIDGE_ERROR_SCHEMA, code: "invalid_protocol" },
    };
  }
  const candidate = value as {
    ok?: unknown;
    data?: unknown;
    error?: unknown;
  };
  if (candidate.ok === true && "data" in candidate) {
    return { ok: true, value: candidate.data as T };
  }
  const error = candidate.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return {
      ok: false,
      error: { schema: BRIDGE_ERROR_SCHEMA, code: "invalid_protocol" },
    };
  }
  const candidateError = error as {
    schema?: unknown;
    code?: unknown;
    status?: unknown;
    resync?: unknown;
  };
  if (candidateError.schema !== BRIDGE_ERROR_SCHEMA) {
    return {
      ok: false,
      error: { schema: BRIDGE_ERROR_SCHEMA, code: "invalid_protocol" },
    };
  }
  const code = normalizeProductApiCode(candidateError.code);
  const status = typeof candidateError.status === "number" &&
      Number.isSafeInteger(candidateError.status) &&
      candidateError.status >= 100 && candidateError.status <= 599
    ? candidateError.status
    : undefined;
  const candidateResync = candidateError.resync;
  const resync = candidateResync && typeof candidateResync === "object" &&
      !Array.isArray(candidateResync)
    ? candidateResync as {
      required?: unknown;
      resource?: unknown;
      reason?: unknown;
    }
    : undefined;
  const typedResync = resync?.required === true &&
      resync.resource === "session-view" &&
      resync.reason === "cursor-expired"
    ? {
      required: true as const,
      resource: "session-view" as const,
      reason: "cursor-expired" as const,
    }
    : undefined;
  const sanitized: SessionViewBridgeError = {
    schema: BRIDGE_ERROR_SCHEMA,
    code,
  };
  if (status !== undefined) sanitized.status = status;
  if (typedResync !== undefined) sanitized.resync = typedResync;
  return { ok: false, error: sanitized };
}

async function invokeProductBridge(
  page: CdpPage,
  method: string,
  argument: unknown,
): Promise<{ ok: boolean; data?: unknown; error?: { code: string } }> {
  return await page.evaluate<{
    ok: boolean;
    data?: unknown;
    error?: { code: string };
  }>(`(async () => {
    const bridge = window.butlerApp;
    if (!bridge || typeof bridge[${JSON.stringify(method)}] !== "function") {
      return { ok: false, error: { code: "bridge_method_unavailable" } };
    }
    try {
      return {
        ok: true,
        data: await bridge[${JSON.stringify(method)}](${JSON.stringify(argument)}),
      };
    } catch {
      return {
        ok: false,
        error: { code: "request_failed" },
      };
    }
  })()`);
}

export async function productCall<T>(launch: ProductLaunch, method: string, argument: unknown): Promise<T> {
  const invocation = await invokeProductBridge(launch.page, method, argument);
  if (!invocation.ok) {
    throw new ProductCallFailure(invocation.error?.code ?? "request_failed");
  }
  if (method !== "getSessionView") return invocation.data as T;
  const envelope = decodeProductCallEnvelope<T>(invocation.data);
  if (!envelope.ok) {
    throw new ProductCallFailure(
      envelope.error.code,
      envelope.error.status,
      envelope.error.resync,
    );
  }
  return envelope.value;
}

/** Shared typed bridge unwrap for every E2E consumer of the public session view. */
export async function sessionViewCall(
  page: CdpPage,
  argument: unknown,
): Promise<AppSessionView> {
  const invocation = await invokeProductBridge(page, "getSessionView", argument);
  if (!invocation.ok) {
    throw new ProductCallFailure(invocation.error?.code ?? "request_failed");
  }
  const envelope = decodeProductCallEnvelope<AppSessionView>(invocation.data);
  if (!envelope.ok) {
    throw new ProductCallFailure(
      envelope.error.code,
      envelope.error.status,
      envelope.error.resync,
    );
  }
  return envelope.value;
}

async function readStep<T>(
  step: PublicReadPathStep,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PublicReadPathFailure) throw error;
    if (error instanceof ProductCallFailure) {
      throw new PublicReadPathFailure(step, error.apiCode);
    }
    throw new PublicReadPathFailure(step, "request_failed");
  }
}

export async function reconnectSse(launch: ProductLaunch, eventCursor: number): Promise<{ events: number; errors: number }> {
  return await launch.page.evaluate(`(async () => {
    let events = 0;
    let errors = 0;
    const off = window.butlerApp.subscribeLiveEvents(
      { cursor: ${Math.max(0, Math.floor(eventCursor))} },
      { onEvent: () => { events += 1; }, onError: () => { errors += 1; } },
    );
    await new Promise((resolve) => setTimeout(resolve, 160));
    off();
    return { events, errors };
  })()`);
}

/**
 * Let the product-owned SSE abort/cancel/release chain settle before sampling
 * physical resources. The unsubscribe itself is exercised by reconnectSse;
 * this bounded renderer turn only prevents its async reader cleanup from
 * racing the following cycle snapshot.
 */
export async function settlePublicReadPathTeardown(launch: ProductLaunch): Promise<void> {
  await launch.page.evaluate(`new Promise((resolve) => {
    setTimeout(resolve, ${PUBLIC_READ_PATH_TEARDOWN_SETTLE_MS});
  })`);
}

export async function currentMessageCursorToken(launch: ProductLaunch, sessionId: string): Promise<string | null> {
  const view = await readStep("initial-view", () => productCall<AppSessionView & {
    message_window?: { next_cursor_token?: string; previous_cursor_token?: string };
  }>(launch, "getSessionView", { sessionId, limit: 64 }));
  return view.message_window?.next_cursor_token ?? null;
}

export async function exercisePublicReadPath(
  launch: ProductLaunch,
  sessionId: string,
  expectedNewCursorToken?: string | null,
): Promise<string[]> {
  const checks: string[] = [];
  const view = await readStep("initial-view", () => productCall<AppSessionView & {
    message_window?: {
      next_cursor_token?: string;
      previous_cursor_token?: string;
    };
  }>(launch, "getSessionView", { sessionId, limit: 64 }));
  if (view.session_id !== sessionId || (view.messages?.length ?? 0) > 64) {
    throw new PublicReadPathFailure("initial-view", "bounded_window_invalid");
  }
  checks.push("large-history-window");
  const cursorToken = expectedNewCursorToken ?? view.message_window?.next_cursor_token ?? null;
  if (!cursorToken) throw new PublicReadPathFailure("delta-refresh", "cursor_missing");
  const delta = await readStep("delta-refresh", () => productCall<AppSessionView & {
    message_window?: { requested_cursor_token?: string };
  }>(launch, "getSessionView", { sessionId, cursorToken, limit: 64 }));
  if (delta.message_window?.requested_cursor_token !== cursorToken) {
    throw new PublicReadPathFailure("delta-refresh", "cursor_not_echoed");
  }
  if (expectedNewCursorToken && (delta.messages?.length ?? 0) === 0) {
    throw new PublicReadPathFailure("delta-refresh", "new_messages_missing");
  }
  checks.push("delta-refresh");
  try {
    await productCall(launch, "getSessionView", {
      sessionId,
      cursorToken: `${cursorToken}-invalid`,
      limit: 64,
    });
    throw new PublicReadPathFailure("cursor-resync", "invalid_cursor_accepted");
  } catch (error) {
    const isResync = error instanceof ProductCallFailure &&
      (error.apiCode === "session_cursor_resync_required" || error.resyncRequired);
    if (!isResync) {
      if (error instanceof PublicReadPathFailure) throw error;
      throw new PublicReadPathFailure("cursor-resync", "resync_error_code_missing");
    }
  }
  checks.push("cursor-resync");
  const previousToken = view.message_window?.previous_cursor_token;
  if (!previousToken) throw new PublicReadPathFailure("before-cursor-page", "cursor_missing");
  await readStep("before-cursor-page", () => productCall(launch, "getSessionView", {
    sessionId,
    beforeCursorToken: previousToken,
    limit: 64,
  }));
  checks.push("before-cursor-page");
  const transcript = await readStep("transcript-export", () => productCall<{ message_count: number }>(launch, "exportTranscript", { sessionId }));
  if (!Number.isSafeInteger(transcript.message_count) || transcript.message_count < 200) {
    throw new PublicReadPathFailure("transcript-export", "history_count_invalid");
  }
  checks.push("transcript-export");
  const eventReplay = await readStep("event-replay", () => productCall<{
    next_cursor?: number;
    cursor?: number;
  }>(launch, "replayEvents", { cursor: 0, limit: 4 }));
  const eventCursor = Number(eventReplay.next_cursor ?? eventReplay.cursor ?? 0);
  if (!Number.isSafeInteger(eventCursor) || eventCursor < 0) {
    throw new PublicReadPathFailure("event-replay", "event_cursor_invalid");
  }
  await readStep("event-replay", () => productCall(launch, "replayEvents", { cursor: eventCursor, limit: 4 }));
  await readStep("usage-health", () => productCall(launch, "getUsageMonitor", { sessionId, sinceHours: 24 }));
  checks.push("usage-health");
  const sse = await readStep("sse-reconnect", () => reconnectSse(launch, eventCursor));
  if (sse.errors > 0) throw new PublicReadPathFailure("sse-reconnect", "stream_error");
  checks.push("sse-reconnect");
  return checks;
}
