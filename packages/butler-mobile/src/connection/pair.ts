import { createGatewayClient, type FetchLike } from "../../../butler-protocol/src/client/index.ts";
import { isStorableId, stringField, type Pairing } from "./pairings";
import { problemFrom, type Problem } from "./problems";

export type PairPlatform = "ios" | "android";
export type PairOutcome = { ok: true; pairing: Pairing } | { ok: false; problem: Problem };
export interface PairInput {
  origin: string;
  code: string;
  device: { name: string; platform: PairPlatform };
  fetch: FetchLike;
  timeoutMs?: number;
}

function pairingFrom(origin: string, data: unknown): Pairing | null {
  if (typeof data !== "object" || data === null) return null;
  const butlerId = stringField(data, "butler_id");
  const deviceId = stringField(data, "device_id");
  const deviceToken = stringField(data, "device_token");
  return butlerId && isStorableId(butlerId) && deviceId && deviceToken ? { origin, butlerId, deviceId, deviceToken } : null;
}

export async function pairDevice(input: PairInput): Promise<PairOutcome> {
  const { origin, code, device, fetch } = input;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 10000);
  try {
    const data = await createGatewayClient({ origin, fetch }).request<unknown>("/devices/pair", {
      body: { code, device_name: device.name, platform: device.platform },
      signal: controller.signal,
    });
    const pairing = pairingFrom(origin, data);
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
