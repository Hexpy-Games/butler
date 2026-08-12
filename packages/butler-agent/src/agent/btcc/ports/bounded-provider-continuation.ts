const MAX_TURN_ITEM_ORDINAL = 1_000_000;

export function turnItemOrdinal(value: string | undefined): number {
  const match = /^turn-item-(0|[1-9]\d{0,6})$/u.exec(value ?? "");
  const ordinal = match ? Number(match[1]) : -1;
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > MAX_TURN_ITEM_ORDINAL) {
    throw new Error("bounded_continuation_turn_item_identity_missing");
  }
  return ordinal;
}

export function validateBoundedProviderOrdinals(
  currentOrdinals: readonly number[],
  responseOrdinal: number,
  deliveredThroughOrdinal: number,
): number {
  if (!Number.isSafeInteger(responseOrdinal) || responseOrdinal < 0 ||
      responseOrdinal > MAX_TURN_ITEM_ORDINAL ||
      !Number.isSafeInteger(deliveredThroughOrdinal) || deliveredThroughOrdinal < -1 ||
      responseOrdinal <= deliveredThroughOrdinal ||
      currentOrdinals.some((ordinal) => !Number.isSafeInteger(ordinal) ||
        ordinal < 0 || ordinal >= responseOrdinal || ordinal > MAX_TURN_ITEM_ORDINAL) ||
      currentOrdinals.some((ordinal, index) => index > 0 &&
        ordinal < currentOrdinals[index - 1]!)) {
    throw new Error("bounded_continuation_item_identity_invalid");
  }
  return responseOrdinal;
}

export function parseDeliveredThroughOrdinal(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 ||
      (value as number) > MAX_TURN_ITEM_ORDINAL) {
    throw new Error("bounded_continuation_watermark_invalid");
  }
  return value as number;
}
