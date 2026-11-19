import { createGatewayClient, type FetchLike } from "../../../butler-protocol/src/client/index.ts";
import { problemFrom, type Problem } from "./problems";

export type ProbeResult = { kind: "ready" } | { kind: "problem"; problem: Problem };

/** The origin the user typed, with http:// when no scheme was given; null when it is not a plain http(s) origin. */
export function butlerOrigin(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/"
      || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function probe(origin: string, token: string, fetch: FetchLike, timeoutMs = 5000): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await createGatewayClient({ origin, fetch, token: () => token }).request<unknown>("/health", { signal: controller.signal });
    return { kind: "ready" };
  } catch (error) {
    return { kind: "problem", problem: problemFrom(error) };
  } finally {
    clearTimeout(timeout);
  }
}
