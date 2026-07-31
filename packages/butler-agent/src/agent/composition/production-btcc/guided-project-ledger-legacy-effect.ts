import {
  findCanonicalProjectLedgerRecordKinds,
  type ProjectLedgerRecordUpdate,
} from "../../adapters/index.ts";
import {
  stableEffectJson,
  type EffectBlockerRelation,
} from "../../btcc/effects/index.ts";
import { isGuidedProjectLedgerEffectTool } from
  "./guided-project-ledger-effect-input.ts";

export async function classifyLegacyProjectLedgerEffect(input: {
  blockerCapability: string;
  currentCapability: string;
  blockerTarget: string;
  blockerInput: Record<string, unknown>;
  normalizedTarget: string;
  normalizedInput: Record<string, unknown>;
  projectRoot: string;
}): Promise<EffectBlockerRelation> {
  if (
    input.blockerCapability !== "project_ledger_update" ||
    !isGuidedProjectLedgerEffectTool(input.currentCapability) ||
    input.currentCapability === "project_ledger_create" ||
    input.normalizedInput.operation !== "update"
  ) {
    return "unrelated";
  }
  const current = projectLedgerTarget(input.normalizedTarget);
  const blocked = projectLedgerTarget(input.blockerTarget);
  if (!current || !blocked || current.id !== blocked.id) return "unrelated";
  if (blocked.kind !== "*" && blocked.kind !== current.kind) return "unrelated";
  if (!Array.isArray(input.blockerInput.updates)) return "ambiguous";

  const updates = normalizeLegacyProjectLedgerUpdates(
    input.blockerInput.updates,
  ).filter((update) => update.id === current.id);
  if (updates.length === 0) return "ambiguous";
  const inferredKind = updates.some((update) => !update.kind)
    ? await uniqueRecordKind(input.projectRoot, current.id)
    : undefined;
  if (updates.some((update) => !update.kind) && !inferredKind) {
    return "ambiguous";
  }
  const matching = updates.filter((update) =>
    (update.kind ?? inferredKind) === current.kind);
  if (matching.length === 0) return "overlapping";
  const latest = matching.at(-1)!;
  const comparable = {
    operation: latest.operation ?? "update",
    ...latest,
    kind: latest.kind ?? inferredKind,
  };
  return stableEffectJson(comparable) === stableEffectJson(input.normalizedInput)
    ? "equivalent"
    : "overlapping";
}

export function normalizeLegacyProjectLedgerUpdates(
  values: unknown[],
): ProjectLedgerRecordUpdate[] {
  return values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Project Ledger legacy effect update ${index} is invalid`);
    }
    const update = value as Record<string, unknown>;
    return definedUpdate({
      id: requiredLegacyId(update.id, index),
      kind: legacyString(update.kind),
      title: legacyString(update.title),
      status: legacyString(update.status),
      body: legacyString(update.body),
      spec: legacyString(update.spec),
      acceptance: legacyString(update.acceptance),
      validation: legacyString(update.validation),
      review: legacyString(update.review),
      report: legacyString(update.report),
      implementation: legacyString(update.implementation),
      mitigation: legacyString(update.mitigation),
      reason: legacyString(update.reason),
      codeCommits: legacyString(update.code_commits),
      ledgerCommits: legacyString(update.ledger_commits),
    });
  });
}

async function uniqueRecordKind(
  projectRoot: string,
  recordId: string,
): Promise<string | undefined> {
  const kinds = await findCanonicalProjectLedgerRecordKinds(
    projectRoot,
    recordId,
  );
  return kinds.length === 1 ? kinds[0] : undefined;
}

function definedUpdate(
  update: ProjectLedgerRecordUpdate,
): ProjectLedgerRecordUpdate {
  return Object.fromEntries(
    Object.entries(update).filter(([, value]) => value !== undefined),
  ) as ProjectLedgerRecordUpdate;
}

function requiredLegacyId(value: unknown, index: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `Project Ledger legacy effect update ${index} requires id`,
    );
  }
  return value.trim();
}

function legacyString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function projectLedgerTarget(
  value: string,
): { kind: string; id: string } | null {
  const match = /^project-ledger:([^:]+):(.+)$/u.exec(value);
  return match ? { kind: match[1]!, id: match[2]! } : null;
}
