import { butlerOrigin } from "./probe";

export type PairLinkParams = Record<string, string | string[] | undefined>;
export type PairLink = { kind: "pair"; origins: string[]; code: string } | { kind: "update_app" } | { kind: "invalid"; origin: string | null; code: string | null };

export function parsePairLink(params: PairLinkParams): PairLink | null {
  const { v, a, c } = params;
  if (v === undefined && a === undefined && c === undefined) return null;
  if (typeof v === "string" && v !== "1") return { kind: "update_app" };
  const raw = a === undefined ? [] : typeof a === "string" ? [a] : a;
  const valid = raw.map(butlerOrigin).filter((origin): origin is string => origin !== null);
  const code = typeof c === "string" && /^\d{8}$/.test(c) ? c : null;
  if (v === "1" && code && raw.length >= 1 && raw.length <= 4 && valid.length === raw.length) {
    return { kind: "pair", origins: [...new Set(valid)], code };
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
