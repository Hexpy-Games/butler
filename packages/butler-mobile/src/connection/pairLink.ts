import { butlerOrigin } from "./probe";

export type PairLinkParams = Record<string, string | string[] | undefined>;
export type PairLink = { kind: "pair"; origin: string; code: string } | { kind: "update_app" } | { kind: "invalid"; origin: string | null; code: string | null };

export function parsePairLink(params: PairLinkParams): PairLink | null {
  const { v, a, c } = params;
  if (v === undefined && a === undefined && c === undefined) return null;
  if (typeof v === "string" && v !== "1") return { kind: "update_app" };
  const origin = typeof a === "string" ? butlerOrigin(a) : null;
  const code = typeof c === "string" && /^\d{8}$/.test(c) ? c : null;
  if (v === "1" && origin && code) return { kind: "pair", origin, code };
  return { kind: "invalid", origin, code };
}
