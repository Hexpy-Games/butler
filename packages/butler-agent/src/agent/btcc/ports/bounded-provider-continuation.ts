const MAX_KEYS = 256;
const MAX_CURRENT_KEYS = 192;
const MAX_RESPONSE_KEYS = MAX_KEYS - MAX_CURRENT_KEYS;
const MAX_KEY_LENGTH = 220;
const SAFE_KEY = /^(?:current-user:\d+|turn-message:[A-Za-z0-9_.:-]{1,160}|function-call:[A-Za-z0-9_.:-]{1,160}|tool-output:[A-Za-z0-9_.:-]{1,160})$/u;

export function boundedProviderItemKeys(
  currentKeys: readonly string[],
  responseKeys: readonly string[],
): string[] {
  validateKeys(currentKeys, MAX_CURRENT_KEYS);
  validateKeys(responseKeys, MAX_RESPONSE_KEYS);
  const keys = [...currentKeys, ...responseKeys]
    .filter((key, index, all) => all.indexOf(key) === index);
  validateKeys(keys, MAX_KEYS);
  return keys;
}

export function validateCurrentBoundedProviderItemKeys(
  value: readonly string[],
): string[] {
  validateKeys(value, MAX_CURRENT_KEYS);
  return [...value];
}

function validateKeys(keys: readonly string[], max: number): void {
  if (keys.length > max || keys.some((key) =>
    typeof key !== "string" || key.length === 0 ||
    key.length > MAX_KEY_LENGTH || !SAFE_KEY.test(key))) {
    throw new Error("bounded_continuation_item_identity_invalid");
  }
}

export function parseBoundedProviderItemKeys(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("bounded_continuation_item_identity_missing");
  return boundedProviderItemKeys(value, []);
}
