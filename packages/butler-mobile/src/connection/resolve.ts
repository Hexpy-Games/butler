import { createGatewayClient, GatewayError, type FetchLike } from "../../../butler-protocol/src/client/index.ts";

export type ResolveResult = { ok: true; origin: string } | { ok: false; problem: "hostNotAllowed" | "notButler" | "unreachable" };

/**
 * Asks every origin for /health at once (no token) and returns the first that answers as a gateway: success, or any
 * gateway error except host_not_allowed and not_butler. The rest are aborted. One origin goes through the same path.
 */
export async function resolveOrigin(origins: readonly string[], fetch: FetchLike, timeoutMs = 5000): Promise<ResolveResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const refused: string[] = [];
  const attempt = async (origin: string) => {
    try {
      await createGatewayClient({ origin, fetch }).request<unknown>("/health", { signal: controller.signal });
      return origin;
    } catch (error) {
      if (error instanceof GatewayError && error.code !== "host_not_allowed" && error.code !== "not_butler") return origin;
      refused.push(error instanceof GatewayError ? error.code : "unreachable");
      throw error;
    }
  };
  try {
    return { ok: true, origin: await Promise.any(origins.map(attempt)) };
  } catch {
    const problem = refused.length > 0 && refused.every(code => code === "not_butler") ? "notButler"
      : refused.length > 0 && refused.every(code => code === "host_not_allowed") ? "hostNotAllowed" : "unreachable";
    return { ok: false, problem };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
