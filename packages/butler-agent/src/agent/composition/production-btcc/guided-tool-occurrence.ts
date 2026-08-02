import { digest, stableJson } from "../../btcc/identity/index.ts";

export function guidedToolOccurrence(input: {
  turnId: string;
  callIndex: number;
  providerCallId?: unknown;
  name: string;
  args: Record<string, unknown>;
}): { callId: string; providerCallId?: string } {
  const providerCallId = normalizedProviderCallId(input.providerCallId);
  return {
    providerCallId,
    callId: digest([
      providerCallId
        ? "btcc-guided-provider-tool-call.v1"
        : "btcc-guided-tool-call.v1",
      input.turnId,
      providerCallId ?? String(input.callIndex),
      input.name,
      stableJson(input.args),
    ].join("\0")),
  };
}

function normalizedProviderCallId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
