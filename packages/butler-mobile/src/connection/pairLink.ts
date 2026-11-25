import { b64urlDecode } from "./tunnel/b64url";
import { butlerOrigin } from "./probe";

export const CLOUD_API_BASE = "https://api.butler.hexpy.games";
const TUNNEL_ID = /^tun_[0-9A-HJKMNP-TV-Z]{26}$/;

export type PairLinkParams = Record<string, string | string[] | undefined>;
export type PairLinkTunnel = { tunnelId: string; desktopStatic: string; relay: string };
export type PairLink = { kind: "pair"; origins: string[]; code: string; tunnel?: PairLinkTunnel } | { kind: "update_app" } | { kind: "invalid"; origin: string | null; code: string | null };

/** k + t (+ optional https u) → relay at `(u ?? prod) + /v1/tunnel/ + t`; null when the pair is present but malformed (padded k included). */
function pairTunnel(k: unknown, t: unknown, u: unknown): PairLinkTunnel | null {
  if (typeof k !== "string" || typeof t !== "string" || (u !== undefined && typeof u !== "string")) return null;
  const base = u === undefined ? CLOUD_API_BASE : butlerOrigin(u);
  if (b64urlDecode(k)?.length !== 32 || !TUNNEL_ID.test(t) || !base?.startsWith("https://")) return null;
  return { tunnelId: t, desktopStatic: k, relay: `${base}/v1/tunnel/${t}` };
}

export function parsePairLink(params: PairLinkParams): PairLink | null {
  const { v, a, c, k, t, u } = params;
  if (v === undefined && a === undefined && c === undefined) return null;
  if (typeof v === "string" && v !== "1") return { kind: "update_app" };
  const raw = a === undefined ? [] : typeof a === "string" ? [a] : a;
  const valid = raw.map(butlerOrigin).filter((origin): origin is string => origin !== null);
  const code = typeof c === "string" && /^\d{8}$/.test(c) ? c : null;
  // k without t (or t without k): ignore k, t and u; the QR is LAN-only.
  const tunnel = k !== undefined && t !== undefined ? pairTunnel(k, t, u) : undefined;
  if (v === "1" && code && tunnel !== null && raw.length >= (tunnel ? 0 : 1) && raw.length <= 4 && valid.length === raw.length) {
    return { kind: "pair", origins: [...new Set(valid)], code, ...(tunnel ? { tunnel } : {}) };
  }
  return { kind: "invalid", origin: valid[0] ?? null, code };
}

/** Query params of a scanned `butler://pair?…` text, each decoded once like Expo Router does (repeated keys → arrays); null for any other text. */
export function pairParamsFromUrl(text: string): PairLinkParams | null {
  const match = /^butler:\/\/pair\/?\?([^#]*)/i.exec(text.trim());
  if (!match) return null;
  const values = new Map<string, string[]>();
  for (const part of match[1].split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decodePart(eq < 0 ? part : part.slice(0, eq));
    const value = decodePart(eq < 0 ? "" : part.slice(eq + 1));
    if (key === null || value === null) return null;
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return Object.fromEntries([...values].map(([key, list]) => [key, list.length === 1 ? list[0] : list]));
}

function decodePart(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}
