import { GatewayError } from "../../../../butler-protocol/src/client/index.ts";

/** A non-200 cloud answer (`{"error":{"code","message"}}`, no protocol_version) as a GatewayError; `http_<status>` when the body names no code. */
export function cloudError(status: number, body: unknown): GatewayError {
  const error: unknown = body && typeof body === "object" ? Reflect.get(body, "error") : undefined;
  const field = (key: string): string | null => {
    const value: unknown = error && typeof error === "object" ? Reflect.get(error, key) : undefined;
    return typeof value === "string" && value !== "" ? value : null;
  };
  const code = field("code") ?? `http_${status}`;
  return new GatewayError(status, code, field("message") ?? code);
}
