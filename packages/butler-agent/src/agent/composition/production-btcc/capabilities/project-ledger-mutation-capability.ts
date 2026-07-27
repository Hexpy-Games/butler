import {
  applyProjectLedgerRecordUpdates,
  type ProjectLedgerRecordUpdate,
} from "../../../adapters/index.ts";
import type { CapabilityExecutionContext } from "./contracts.ts";

export async function updateProjectLedger(
  args: Record<string, unknown>,
  context: CapabilityExecutionContext,
): Promise<unknown> {
  const effect = context.externalEffect;
  if (!effect || !effect.targetScopeRef.startsWith("ledger:")) {
    throw new Error("Project Ledger mutation requires an admitted Ledger effect target");
  }
  if (!context.resolveProjectLedgerRoot) {
    throw new Error("Project Ledger mutation has no active binding resolver");
  }
  const updates = requireUpdates(args.updates);
  const projectRef = effect.targetScopeRef.slice("ledger:".length);
  if (!projectRef) throw new Error("Project Ledger effect target is empty");
  return applyProjectLedgerRecordUpdates({
    butlerData: context.butlerData,
    projectRoot: context.resolveProjectLedgerRoot(projectRef),
    effectKey: [
      effect.effectIntentRef.id,
      effect.effectIntentRef.sha256,
      effect.occurrenceKey,
    ].join(":"),
    updates,
  });
}

function requireUpdates(value: unknown): ProjectLedgerRecordUpdate[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Project Ledger mutation requires record updates");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Project Ledger update ${index} is invalid`);
    }
    const input = item as Record<string, unknown>;
    const id = requireString(input.id, `updates[${index}].id`);
    return {
      id,
      ...optionalString(input, "kind"),
      ...optionalString(input, "title"),
      ...optionalString(input, "status"),
      ...optionalString(input, "body"),
      ...optionalString(input, "spec"),
      ...optionalString(input, "acceptance"),
      ...optionalString(input, "validation"),
      ...optionalString(input, "review"),
      ...optionalString(input, "report"),
      ...optionalString(input, "implementation"),
      ...optionalString(input, "mitigation"),
      ...optionalString(input, "reason"),
      ...renamedString(input, "code_commits", "codeCommits"),
      ...renamedString(input, "ledger_commits", "ledgerCommits"),
    };
  });
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function optionalString(input: Record<string, unknown>, key: string) {
  const value = input[key];
  return typeof value === "string" ? { [key]: value } : {};
}

function renamedString(input: Record<string, unknown>, key: string, target: string) {
  const value = input[key];
  return typeof value === "string" ? { [target]: value } : {};
}
