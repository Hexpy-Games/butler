import { createHash } from "node:crypto";
import type {
  HistoricalImportDecision,
  HistoricalSourceKind,
} from "./historical-recovery-types.ts";

export function historicalRecoverySourceRef(decision: HistoricalImportDecision): string {
  return `recovery:${decision.source_kind}:${stableHash([
    decision.source_kind,
    decision.session_id,
    decision.source_id,
  ])}`;
}

export function redactedReportRef(
  scope: HistoricalSourceKind | "session" | "conversation_session" | "conversation_turn" | "conversation_message" | "audit",
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return `${scope}:${stableHash([scope, trimmed]).slice(0, 16)}`;
}

function stableHash(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 32);
}
