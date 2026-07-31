import { createHash } from "node:crypto";
import type { GuidedEffectIdentity } from "./contracts.ts";

type EffectIdentityInput = {
  workId: string;
  planRevisionId: string;
  actionKey: string;
  capability: string;
  normalizedTarget: string;
  sanitizedTarget: string;
  normalizedInput: unknown;
};

export function createGuidedEffectIdentity(
  input: EffectIdentityInput,
): GuidedEffectIdentity {
  const inputJson = stableEffectJson(input.normalizedInput);
  const inputSha256 = digest(inputJson);
  const targetSha256 = digest(input.normalizedTarget);
  const identityBody = {
    version: 1,
    workId: input.workId,
    planRevisionId: input.planRevisionId,
    actionKey: input.actionKey,
    capability: input.capability,
    targetSha256,
    inputSha256,
  };
  const slotSha256 = digest(stableEffectJson({
    version: 1,
    workId: input.workId,
    planRevisionId: input.planRevisionId,
    actionKey: input.actionKey,
    capability: input.capability,
    targetSha256,
  }));
  const identitySha256 = digest(stableEffectJson(identityBody));
  const requestSha256 = digest(stableEffectJson({
    capability: input.capability,
    normalizedTarget: input.normalizedTarget,
    normalizedInput: input.normalizedInput,
  }));
  return {
    effectId: `guided-effect-${slotSha256}`,
    receiptId: `guided-effect-receipt-${identitySha256}`,
    idempotencyKey: `guided-effect-idempotency-${identitySha256}`,
    identitySha256,
    requestSha256,
    inputSha256,
    targetSha256,
    workId: input.workId,
    planRevisionId: input.planRevisionId,
    actionKey: input.actionKey,
    capability: input.capability,
    sanitizedTarget: input.sanitizedTarget,
  };
}

export function stableEffectJson(value: unknown): string {
  const encoded = JSON.stringify(normalize(value));
  if (encoded === undefined) {
    throw new Error("Effect input must be JSON-serializable");
  }
  return encoded;
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "string") return value;
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Effect input rejects non-finite numbers");
  }
  if (typeof value === "number") return value;
  if (value === undefined) {
    throw new Error("Effect input rejects undefined values");
  }
  if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) {
      throw new Error("Effect input requires plain JSON objects");
    }
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, child]) => [key, normalize(child)] as const,
    );
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return Object.fromEntries(entries);
  }
  throw new Error(`Effect input rejects ${typeof value} values`);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
