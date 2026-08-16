import type { GuidedToolJournalRecord } from "../ports/index.ts";
import {
  guidedToolCatalogIdFromRawArguments,
  guidedToolIdentitySignature,
} from "./guided-tool-occurrence.ts";

export type GuidedToolResumePool = {
  claim(
    toolName: string,
    args: Record<string, unknown>,
    catalogId?: string,
  ): string | undefined;
  discard(callId: string): void;
};

export function createGuidedToolResumePool(
  records: readonly GuidedToolJournalRecord[],
): GuidedToolResumePool {
  const availableCallIds = new Set(records.map((record) => record.callId));
  const callsBySignature = new Map<string, string[]>();
  for (const record of records) {
    const signature = guidedToolResumeSignature(
      record.toolName,
      record.arguments,
      guidedToolCatalogIdFromRawArguments(record.rawArguments),
    );
    const calls = callsBySignature.get(signature) ?? [];
    calls.push(record.callId);
    callsBySignature.set(signature, calls);
  }
  return {
    claim(toolName, args, catalogId) {
      const calls = callsBySignature.get(
        guidedToolResumeSignature(toolName, args, catalogId),
      );
      while (calls?.length) {
        const callId = calls.shift()!;
        if (!availableCallIds.delete(callId)) continue;
        return callId;
      }
      return undefined;
    },
    discard(callId) {
      availableCallIds.delete(callId);
    },
  };
}

function guidedToolResumeSignature(
  toolName: string,
  args: Record<string, unknown>,
  catalogId?: string,
): string {
  return guidedToolIdentitySignature(toolName, args, catalogId);
}
