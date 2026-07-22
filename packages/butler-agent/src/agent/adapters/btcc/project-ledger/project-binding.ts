export type ProjectLedgerBinding =
  | { kind: "canonical_ledger_id"; ledgerProjectId: string }
  | { kind: "app_project_id"; appProjectId: string };

const CANONICAL_LEDGER_PREFIX = "project:";

export function decodeProjectLedgerBinding(projectRef: string): ProjectLedgerBinding {
  if (!projectRef.startsWith(CANONICAL_LEDGER_PREFIX)) {
    return { kind: "app_project_id", appProjectId: projectRef };
  }
  const ledgerProjectId = projectRef.slice(CANONICAL_LEDGER_PREFIX.length);
  if (!ledgerProjectId) throw new Error("Canonical Project Ledger binding is empty");
  return { kind: "canonical_ledger_id", ledgerProjectId };
}
