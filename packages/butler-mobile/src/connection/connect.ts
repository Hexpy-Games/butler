import { Platform } from "react-native";
import { router } from "expo-router";
import { thisDevice } from "./device";
import { isLocalNetworkHost } from "./localNetwork";
import { nativeFetch } from "./nativeFetch";
import { pairDevice } from "./pair";
import type { Problem } from "./problems";
import { resolveOrigin } from "./resolve";
import { pairingStore } from "./store";

// iOS may refuse the first local-network connection while it asks for permission: explain once per app run.
let localNetworkExplained = false;

/** Pairs with the Butler at `origin`, saves the pairing and opens home as the only screen; returns the problem on failure. */
export async function pairAndOpenHome(origin: string, code: string): Promise<Problem | null> {
  const result = await pairDevice({ origin, code, device: thisDevice(), fetch: nativeFetch });
  if (!result.ok) return result.problem;
  try {
    await pairingStore.save(result.pairing);
  } catch {
    return "failed";
  }
  if (router.canDismiss()) router.dismissAll();
  router.replace("/home");
  return null;
}

/** Scan path: picks the reachable origin among the QR's addresses, then pairs there. On failure, `origin` is the one to prefill. */
export async function pairAnyAndOpenHome(origins: string[], code: string): Promise<{ origin: string; problem: Problem } | null> {
  const resolved = await resolveOrigin(origins, nativeFetch);
  if (!resolved.ok) return { origin: origins[0], problem: resolved.problem };
  const problem = await pairAndOpenHome(resolved.origin, code);
  return problem ? { origin: resolved.origin, problem } : null;
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
