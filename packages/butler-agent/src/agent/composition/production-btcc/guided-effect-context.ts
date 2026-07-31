import type { GuidedEffectJournalRecord } from "../../btcc/effects/index.ts";

export function renderGuidedEffectContext(
  records: readonly GuidedEffectJournalRecord[],
): string {
  if (records.length === 0) return "";
  return records.slice(0, 12).map((record) => {
    const receipt = record.receipt
      ? `, receipt ${record.receipt.receiptId}, applied ${record.receipt.appliedAt}`
      : "";
    const error = record.error ? `, issue ${record.error.code}` : "";
    return `- ${record.capability} -> ${record.sanitizedTarget}: ${record.status}` +
      `${receipt}${error}`;
  }).join("\n");
}
