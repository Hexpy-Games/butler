import { APP_PROTOCOL_VERSION } from "../message-session-contracts.ts";

/** A gateway answer that is not success: HTTP status plus the envelope error code (`http_<status>` when the body names none). */
export class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly error?: Record<string, unknown>) {
    super(message);
    this.name = "GatewayError";
  }
}

/** Unwraps `{protocol_version, data | error}`. Throws GatewayError: `not_butler` when the body is not an envelope, `protocol_mismatch` (message = server version) when the version differs, else the error code. */
export function readEnvelope<T>(status: number, body: unknown): T {
  if (!body || typeof body !== "object" || !("protocol_version" in body) || typeof body.protocol_version !== "string") {
    throw new GatewayError(status, "not_butler", "not_butler");
  }
  if (body.protocol_version !== APP_PROTOCOL_VERSION) {
    throw new GatewayError(status, "protocol_mismatch", body.protocol_version);
  }
  const envelope = body as Record<string, unknown>;
  if (status >= 200 && status < 300) return envelope.data as T;
  const error = envelope.error && typeof envelope.error === "object"
    ? envelope.error as Record<string, unknown> : undefined;
  const code = typeof error?.code === "string" ? error.code : `http_${status}`;
  const message = typeof error?.message === "string" ? error.message : code;
  throw new GatewayError(status, code, message, error);
}
