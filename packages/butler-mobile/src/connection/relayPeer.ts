import { x25519 } from "@noble/curves/ed25519.js";
import type { Pairing } from "./pairings";
import { relayAddress } from "./route";
import { pairingStore } from "./store";
import { b64urlDecode, b64urlEncode } from "./tunnel/b64url";
import { randomBytes } from "./tunnel/random";
import type { RelayPeer } from "./tunnel/transport";

export function newNoiseKey(): { privateKey: Uint8Array; publicKey: Uint8Array; privateText: string; publicText: string } {
  const privateKey = randomBytes(32), publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey, privateText: b64urlEncode(privateKey), publicText: b64urlEncode(publicKey) };
}

export async function loadRelayPeer(pairing: Pairing): Promise<RelayPeer | null> {
  const address = relayAddress(pairing);
  const privateKey = b64urlDecode((await pairingStore.loadNoiseKey(pairing)) ?? "");
  const desktopStatic = b64urlDecode(pairing.desktopStatic ?? "");
  if (!address || !pairing.tunnelId || privateKey?.length !== 32 || desktopStatic?.length !== 32) return null;
  return { address, tunnelId: pairing.tunnelId, desktopStatic, privateKey, publicKey: x25519.getPublicKey(privateKey) };
}
