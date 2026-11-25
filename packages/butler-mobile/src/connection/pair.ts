import { createGatewayClient, type FetchLike } from "../../../butler-protocol/src/client/index.ts";
import { isStorableId, noiseKeyName, stringField, type Pairing } from "./pairings";
import { problemFrom, type Problem } from "./problems";

export type PairPlatform = "ios" | "android";
export type PairOutcome = { ok: true; pairing: Pairing } | { ok: false; problem: Problem };
export interface PairInput {
  origin: string;            // LAN origin, or the relay address when fetch is the relay FetchLike
  addresses: string[];       // what the saved pairing stores
  code: string;
  device: { name: string; platform: PairPlatform };
  fetch: FetchLike;
  noiseStatic?: string;      // phone public key, base64url; sent whenever the QR had k (LAN and relay)
  tunnel?: { tunnelId: string; desktopStatic: string };
  timeoutMs?: number;
}

function pairingFrom(input: PairInput, data: unknown): Pairing | null {
  if (typeof data !== "object" || data === null) return null;
  const butlerId = stringField(data, "butler_id");
  const deviceId = stringField(data, "device_id");
  const deviceToken = stringField(data, "device_token");
  const computerName = stringField(data, "computer_name");
  return butlerId && isStorableId(butlerId) && deviceId && deviceToken ? {
    addresses: input.addresses, butlerId, deviceId, deviceToken, ...(computerName ? { computerName } : {}),
    ...(input.tunnel ? { tunnelId: input.tunnel.tunnelId, desktopStatic: input.tunnel.desktopStatic, noiseStatic: noiseKeyName(butlerId) } : {}),
  } : null;
}

export async function pairDevice(input: PairInput): Promise<PairOutcome> {
  const { origin, code, device, fetch } = input;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 10000);
  try {
    const data = await createGatewayClient({ origin, fetch }).request<unknown>("/devices/pair", {
      body: { code, device_name: device.name, platform: device.platform, ...(input.noiseStatic ? { noise_static: input.noiseStatic } : {}) },
      signal: controller.signal,
    });
    const pairing = pairingFrom(input, data);
    return pairing ? { ok: true, pairing } : { ok: false, problem: "failed" };
  } catch (error) {
    return { ok: false, problem: problemFrom(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export function pairDeviceName(candidates: readonly (string | null | undefined)[], fallback: string): string {
  for (const candidate of candidates) {
    const name = Array.from((candidate ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim()).slice(0, 64).join("").trim();
    if (name) return name;
  }
  return fallback;
}

export function codeDigits(text: string): string {
  return text.replace(/\D/g, "").slice(0, 8);
}
