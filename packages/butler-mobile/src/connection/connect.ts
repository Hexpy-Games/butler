import { Platform } from "react-native";
import { router } from "expo-router";
import { createGatewayClient, type FetchLike } from "../../../butler-protocol/src/client/index.ts";
import { enablePush } from "@/notifications/push";
import { thisDevice } from "./device";
import { isLocalNetworkHost } from "./localNetwork";
import { nativeFetch } from "./nativeFetch";
import { pairDevice, type PairInput } from "./pair";
import type { PairLinkTunnel } from "./pairLink";
import type { Problem } from "./problems";
import { newNoiseKey } from "./relayPeer";
import { resolveOrigin } from "./resolve";
import { pairingStore } from "./store";
import { b64urlDecode } from "./tunnel/b64url";
import { createRelayFetch } from "./tunnel/relayFetch";

// iOS may refuse the first local-network connection while it asks for permission: explain once per app run.
let localNetworkExplained = false;

type PairTarget = { origin: string; fetch: FetchLike };
type PairRecord = Pick<PairInput, "addresses" | "noiseStatic" | "tunnel"> & { noisePrivate?: string };

async function pairAt(target: PairTarget, code: string, record: PairRecord): Promise<Problem | null> {
  const result = await pairDevice({ ...record, origin: target.origin, fetch: target.fetch, code, device: thisDevice() });
  if (!result.ok) return result.problem;
  try {
    await pairingStore.save(result.pairing, record.noisePrivate);
  } catch {
    return "failed";
  }
  void enablePush(createGatewayClient({ origin: target.origin, fetch: target.fetch, token: () => result.pairing.deviceToken }), result.pairing.butlerId);
  if (router.canDismiss()) router.dismissAll();
  router.replace("/home");
  return null;
}

/** Manual entry: LAN only (no k without a QR). */
export function pairAndOpenHome(origin: string, code: string): Promise<Problem | null> {
  return pairAt({ origin, fetch: nativeFetch }, code, { addresses: [origin] });
}

/**
 * Scan path. LAN resolve first; if no LAN address answers and the QR has k + t, the pair request goes through the relay at once
 * (it is the probe). Nothing else spends the code's 60 s. On failure, `origin` is the LAN address to prefill ("" when none) and `relay` says the failing attempt went through the relay.
 */
export async function pairAnyAndOpenHome(link: { origins: string[]; code: string; tunnel?: PairLinkTunnel }): Promise<{ origin: string; problem: Problem; relay: boolean } | null> {
  const key = link.tunnel ? newNoiseKey() : null;
  const resolved = link.origins.length > 0 ? await resolveOrigin(link.origins, nativeFetch) : null;
  const relay = link.tunnel && key ? {
    origin: link.tunnel.relay,
    fetch: createRelayFetch({ address: link.tunnel.relay, tunnelId: link.tunnel.tunnelId, desktopStatic: b64urlDecode(link.tunnel.desktopStatic)!, privateKey: key.privateKey, publicKey: key.publicKey }),
  } : null;
  const lan = resolved?.ok ? [resolved.origin, ...link.origins.filter(origin => origin !== resolved.origin)] : link.origins;
  const record: PairRecord = {
    addresses: relay ? [...lan, relay.origin] : lan,
    ...(link.tunnel && key ? { tunnel: { tunnelId: link.tunnel.tunnelId, desktopStatic: link.tunnel.desktopStatic }, noiseStatic: key.publicText, noisePrivate: key.privateText } : {}),
  };
  const target = resolved?.ok ? { origin: resolved.origin, fetch: nativeFetch } : relay;
  if (!target) return { origin: link.origins[0] ?? "", problem: resolved && !resolved.ok ? resolved.problem : "unreachable", relay: false };
  const problem = await pairAt(target, link.code, record);
  return problem ? { origin: target === relay ? link.origins[0] ?? "" : target.origin, problem, relay: target === relay } : null;
}

/** The deep-link prefill address: the reachable origin, else the first. */
export async function prefillOrigin(origins: string[]): Promise<string> {
  const resolved = await resolveOrigin(origins, nativeFetch);
  return resolved.ok ? resolved.origin : origins[0];
}

/** True once per app run when an iOS failure to a LAN host should show the local-network explainer. */
export function explainLocalNetwork(problem: Problem, origin: string): boolean {
  if (problem !== "unreachable" || Platform.OS !== "ios" || localNetworkExplained || !isLocalNetworkHost(origin)) return false;
  localNetworkExplained = true;
  return true;
}
