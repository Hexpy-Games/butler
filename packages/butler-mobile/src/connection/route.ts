import type { FetchLike } from "../../../butler-protocol/src/client/index.ts";
import type { Pairing } from "./pairings";
import { probe } from "./probe";
import type { Problem } from "./problems";

export type Route = { kind: "lan" | "relay"; origin: string; fetch: FetchLike };
export type RouteResult = { kind: "ready"; route: Route } | { kind: "problem"; problem: Problem };

const LAN_PROBE_MS = 5_000;
const LAN_PROBE_WITH_RELAY_MS = 2_000; // a LAN answer takes milliseconds; don't hold the relay back for long
const RELAY_PROBE_MS = 15_000;

export function relayAddress(pairing: Pairing): string | null {
  return pairing.tunnelId ? pairing.addresses[pairing.addresses.length - 1] ?? null : null;
}

export function displayAddress(pairing: Pairing, address: string, outsideAccess: string): string {
  return address === relayAddress(pairing) ? outsideAccess : address;
}

export function lanAddresses(pairing: Pairing): string[] {
  return pairing.tunnelId ? pairing.addresses.slice(0, -1) : pairing.addresses;
}

/** LAN addresses at once (first ready wins), then the relay. A needsPairing answer from any LAN address ends the search. */
export async function chooseRoute(pairing: Pairing, lanFetch: FetchLike, relayFetch: FetchLike | null): Promise<RouteResult> {
  const relay = relayFetch ? relayAddress(pairing) : null;
  const timeout = relay ? LAN_PROBE_WITH_RELAY_MS : LAN_PROBE_MS;
  const probes = lanAddresses(pairing).map(origin => probe(origin, pairing.deviceToken, lanFetch, timeout).then(result => ({ origin, result })));
  const ready = await Promise.any(probes.map(p => p.then(({ origin, result }) => result.kind === "ready" ? origin : Promise.reject(result)))).catch(() => null);
  if (ready) return { kind: "ready", route: { kind: "lan", origin: ready, fetch: lanFetch } };
  const problems = (await Promise.all(probes)).map(({ result }) => result.kind === "problem" ? result.problem : "failed");
  if (problems.includes("needsPairing")) return { kind: "problem", problem: "needsPairing" };
  if (relay && relayFetch) {
    const result = await probe(relay, pairing.deviceToken, relayFetch, RELAY_PROBE_MS);
    return result.kind === "ready" ? { kind: "ready", route: { kind: "relay", origin: relay, fetch: relayFetch } } : { kind: "problem", problem: result.problem };
  }
  return { kind: "problem", problem: problems[0] ?? "unreachable" };
}
