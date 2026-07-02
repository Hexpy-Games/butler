import type {
  HistoricalImportDecision,
  HistoricalRecoveryMapping,
  HistoricalRecoveryReport,
  HistoricalRecoveryReportRow,
  ImportOutcome,
} from "./historical-recovery-types.ts";
import { redactedReportRef } from "./historical-recovery-identity.ts";

export function buildHistoricalRecoveryReport(input: {
  decisions: HistoricalImportDecision[];
  dryRun?: boolean;
  outcomes?: ImportOutcome[];
}): HistoricalRecoveryReport {
  const outcomes = input.outcomes ?? [];
  const mappings = outcomes.flatMap((outcome) => outcome.mapping ? [redactedMapping(outcome.mapping)] : []);
  return {
    ok: true,
    dry_run: input.dryRun !== false,
    counts: {
      total: input.decisions.length,
      trusted: input.decisions.filter((decision) => decision.provenance === "trusted").length,
      recovered: input.decisions.filter((decision) => decision.provenance === "recovered").length,
      discarded: input.decisions.filter((decision) => decision.provenance === "discarded").length,
      ambiguous: input.decisions.filter((decision) => decision.provenance === "ambiguous").length,
      admissible: input.decisions.filter((decision) => decision.admit).length,
      imported: outcomes.filter((outcome) => outcome.imported).length,
      skipped_existing: outcomes.filter((outcome) => outcome.skippedExisting).length,
    },
    rows: input.decisions.map(redactedRow),
    mappings,
    privacy: {
      rawTextIncluded: false,
      secretsIncluded: false,
    },
  };
}

function redactedRow(decision: HistoricalImportDecision): HistoricalRecoveryReportRow {
  return {
    source_kind: decision.source_kind,
    source_id: redactedReportRef(decision.source_kind, `${decision.session_id}:${decision.source_id}`) ?? "unknown",
    session_id: redactedReportRef("session", decision.session_id) ?? "unknown",
    conversation_session_id: redactedReportRef("conversation_session", decision.conversation_session_id),
    conversation_turn_id: redactedReportRef("conversation_turn", decision.conversation_turn_id),
    conversation_message_id: redactedReportRef("conversation_message", decision.conversation_message_id),
    provenance: decision.provenance,
    admit: decision.admit,
    reason: decision.reason,
    role: decision.role,
    created_at: decision.created_at,
    audit_refs: decision.audit_refs.flatMap((ref) => redactedReportRef("audit", ref) ?? []),
  };
}

function redactedMapping(mapping: HistoricalRecoveryMapping): HistoricalRecoveryMapping {
  return {
    source_kind: mapping.source_kind,
    source_id: redactedReportRef(mapping.source_kind, mapping.source_id) ?? "unknown",
    conversation_session_id: redactedReportRef("conversation_session", mapping.conversation_session_id) ?? "unknown",
    conversation_message_id: redactedReportRef("conversation_message", mapping.conversation_message_id) ?? "unknown",
    status: mapping.status,
  };
}
