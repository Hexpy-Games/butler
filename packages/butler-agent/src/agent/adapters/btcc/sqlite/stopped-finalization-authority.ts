import type { Database } from "bun:sqlite";
import type {
  ContinuationContext,
  FinalizationContinuation,
  FinalDossierProduct,
  GoalContractRecord,
  PreparedReportProduct,
  ReviewedManagedProgramState,
} from "../../../btcc/gateway-api.ts";
import { contentRef, ledgerManifestContentHash } from "../../../btcc/gateway-api.ts";
import { digest, stableJson } from "./identity.ts";

type Ref = { id: string; sha256: string };

export type StoppedFinalizationRow = {
  candidate_id: string;
  anchor_id: string;
  anchor_sha256: string;
  blocker_id: string;
  blocker_sha256: string;
  source_turn_id: string;
  ledger_id: string;
  program_id: string;
  expected_manifest_revision: number;
  base_manifest_hash: string;
  goal_contract_ref: string;
  resume_at: FinalizationContinuation["resumeAt"];
};

export function loadStoppedFinalizationContext(
  db: Database,
  row: StoppedFinalizationRow,
  program: ReviewedManagedProgramState,
): ContinuationContext & { finalization: FinalizationContinuation } {
  assertProgramAuthority(row, program);
  const anchor = decodeAnchor(db, row);
  const blocker = decodeBlocker(db, anchor.blockerRef, row);
  const originalGoalContract = decodeGoalContract(db, program.goalContractRef);
  return {
    originalGoalContract,
    acceptedPlan: program.acceptedPlan,
    blocker,
    frontier: { openWorkRefs: [], openTaskRefs: [] },
    finalization: loadFinalizationInput(db, row, anchor.inputRef, program),
  };
}

export function assertStoppedFinalizationInput(
  db: Database,
  row: StoppedFinalizationRow,
  finalization: FinalizationContinuation,
): void {
  const anchor = decodeAnchor(db, row);
  if (finalization.resumeAt !== anchor.resumeAt) {
    throw new Error("Stopped finalization resume point changed");
  }
  if (finalization.resumeAt === "consolidation") {
    assertProgramAuthority(row, finalization.closedProgram);
    assertRef(anchor.inputRef, closedProgramRef(finalization.closedProgram), "closed Program");
    return;
  }
  if (finalization.resumeAt === "reporting") {
    const stored = decodeFinalDossier(db, anchor.inputRef, row);
    assertSameJson(finalization.finalDossier, stored, "FinalDossier");
    return;
  }
  const stored = decodePreparedReport(db, anchor.inputRef, row);
  assertSameJson(finalization.preparedReport, stored, "PreparedReport");
}

export function loadStoppedFinalizationGoalContract(
  db: Database,
  ref: Ref,
): GoalContractRecord {
  return decodeGoalContract(db, ref);
}

function loadFinalizationInput(
  db: Database,
  row: StoppedFinalizationRow,
  inputRef: Ref,
  program: ReviewedManagedProgramState,
): FinalizationContinuation {
  if (row.resume_at === "consolidation") {
    assertRef(inputRef, closedProgramRef(program), "closed Program");
    return { resumeAt: "consolidation", closedProgram: program };
  }
  if (row.resume_at === "reporting") {
    return { resumeAt: "reporting", finalDossier: decodeFinalDossier(db, inputRef, row) };
  }
  return { resumeAt: "delivery", preparedReport: decodePreparedReport(db, inputRef, row) };
}

function decodeAnchor(db: Database, row: StoppedFinalizationRow) {
  const ref = { id: row.anchor_id, sha256: row.anchor_sha256 };
  const value = loadImmutable(db, ref, "user_stopped_finalization_anchor");
  exactKeys(value, [
    "kind", "sourceTurnId", "programId", "resumeAt", "blockerRef", "inputRef",
  ], "Stopped finalization anchor");
  if (value.kind !== "user_stopped_finalization" ||
    value.sourceTurnId !== row.source_turn_id || value.programId !== row.program_id ||
    value.resumeAt !== row.resume_at) {
    throw new Error("Stopped finalization anchor changed");
  }
  const blockerRef = decodeRef(value.blockerRef, "anchor.blockerRef");
  const inputRef = decodeRef(value.inputRef, "anchor.inputRef");
  assertRef(blockerRef, { id: row.blocker_id, sha256: row.blocker_sha256 }, "blocker");
  assertRef(ref, stoppedRecordRef("stopped-finalization-anchor", value), "anchor");
  return { resumeAt: row.resume_at, blockerRef, inputRef };
}

function decodeBlocker(db: Database, ref: Ref, row: StoppedFinalizationRow) {
  const value = loadImmutable(db, ref, "user_stopped_finalization_blocker");
  exactKeys(value, ["kind", "sourceTurnId", "sourceState", "reason", "readiness"],
    "Stopped finalization blocker");
  if (value.kind !== "user_stopped_finalization" || value.sourceTurnId !== row.source_turn_id ||
    typeof value.sourceState !== "string" || typeof value.reason !== "string") {
    throw new Error("Stopped finalization blocker changed");
  }
  assertRef(ref, stoppedRecordRef("user_stopped_finalization-blocker", value), "blocker");
  return {
    sourceState: value.sourceState,
    reason: value.reason,
    readiness: value.readiness,
  };
}

function decodeGoalContract(db: Database, ref: Ref): GoalContractRecord {
  const value = loadImmutable(db, ref, ["goal_contract", "ledger_source_record"]);
  assertEmbeddedRef(value, ref, "GoalContract");
  if (!Array.isArray(value.fields) || value.fields.length !== 2 ||
    value.fields[0]?.fieldId !== "request" || value.fields[1]?.fieldId !== "intended_result") {
    throw new Error("Stopped finalization GoalContract is not structurally closed");
  }
  return value as GoalContractRecord;
}

function decodeFinalDossier(
  db: Database,
  ref: Ref,
  authority: Pick<StoppedFinalizationRow, "program_id" | "goal_contract_ref">,
): FinalDossierProduct {
  const dossier = loadImmutable(db, ref, "final_dossier");
  assertEmbeddedRef(dossier, ref, "FinalDossier", "final-dossier");
  exactKeys(dossier, [
    "ref", "programId", "originalGoalContractRef", "currentAuthorityRef",
    "consolidationAssessmentRef", "acceptedPlanRef", "planningReviewRef",
    "taskReviewRefs", "goalCoverage", "semanticFidelity", "promotionClosure",
    "disposition", "blockerRef", "deferredAnchorRef", "openWorkRefs",
    "continuationOpenTaskRefs", "summary", "userReport",
  ], "FinalDossier", true);
  const originalGoalRef = decodeRef(
    dossier.originalGoalContractRef,
    "FinalDossier.originalGoalContractRef",
  );
  if (dossier.programId !== authority.program_id ||
    originalGoalRef.id !== authority.goal_contract_ref || dossier.semanticFidelity !== "faithful" ||
    !Array.isArray(dossier.taskReviewRefs) || !isRecord(dossier.userReport)) {
    throw new Error("Stopped FinalDossier is not structurally closed");
  }
  return { kind: "final_dossier", dossier } as FinalDossierProduct;
}

function decodePreparedReport(
  db: Database,
  reportRef: Ref,
  row: Pick<StoppedFinalizationRow, "source_turn_id" | "program_id" | "goal_contract_ref">,
): PreparedReportProduct {
  const report = loadImmutable(db, reportRef, "prepared_report");
  exactKeys(report, ["ref", "finalDossierRef", "content", "contentSha256"], "PreparedReport");
  assertEmbeddedRef(report, reportRef, "PreparedReport", "prepared-report");
  const dossierRef = decodeRef(report.finalDossierRef, "report.finalDossierRef");
  const dossier = decodeFinalDossier(db, dossierRef, row).dossier;
  if (typeof report.content !== "string" || report.contentSha256 !== digest(report.content)) {
    throw new Error("Stopped PreparedReport content changed");
  }
  const payloadBody = {
    turnId: row.source_turn_id,
    reportRef,
    finalDossierRef: dossierRef,
    contentSha256: report.contentSha256,
    route: "managed" as const,
    disposition: dossier.disposition,
    content: report.content,
  };
  const payloadRef = contentRef("payload", payloadBody);
  const finalPayload = loadImmutable(db, payloadRef, "final_payload");
  exactKeys(finalPayload, [
    "ref", "turnId", "reportRef", "finalDossierRef", "contentSha256", "route",
    "disposition", "content",
  ], "PreparedReport final payload");
  assertSameJson(finalPayload, { ref: payloadRef, ...payloadBody }, "PreparedReport payload");
  return { kind: "prepared_report", report, finalPayload } as PreparedReportProduct;
}

function assertProgramAuthority(
  row: Pick<StoppedFinalizationRow, "ledger_id" | "program_id" | "expected_manifest_revision" |
    "goal_contract_ref" | "base_manifest_hash">,
  program: ReviewedManagedProgramState,
): void {
  if (program.frontier !== "closed" || program.ledgerId !== row.ledger_id ||
    program.programId !== row.program_id ||
    program.manifestRevision !== row.expected_manifest_revision ||
    program.goalContractRef.id !== row.goal_contract_ref ||
    ledgerManifestContentHash(program, {
      ledgerId: row.ledger_id,
      programId: row.program_id,
    }) !== row.base_manifest_hash) {
    throw new Error("Stopped finalization Program authority changed");
  }
}

function closedProgramRef(program: ReviewedManagedProgramState): Ref {
  return stoppedRecordRef("closed-program", {
    ledgerId: program.ledgerId,
    programId: program.programId,
    manifestRevision: program.manifestRevision,
  });
}

function stoppedRecordRef(kind: string, body: unknown): Ref {
  const bytes = stableJson(body);
  return { id: digest(`btcc-${kind}.v1\0${bytes}`), sha256: digest(bytes) };
}

function loadImmutable(
  db: Database,
  ref: Ref,
  expectedKind: string | string[],
): Record<string, any> {
  const row = db.query<{ kind: string; sha256: string; content_json: string }, [string]>(`
    SELECT kind, sha256, content_json FROM btcc_records WHERE record_id = ?
  `).get(ref.id);
  const kinds = Array.isArray(expectedKind) ? expectedKind : [expectedKind];
  if (!row || !kinds.includes(row.kind) || row.sha256 !== ref.sha256) {
    throw new Error(`Stopped finalization immutable ${kinds.join("/")} record changed`);
  }
  const value = JSON.parse(row.content_json) as unknown;
  if (!isRecord(value) || stableJson(value) !== row.content_json) {
    throw new Error(`Stopped finalization immutable ${kinds.join("/")} bytes changed`);
  }
  return value;
}

function assertEmbeddedRef(
  value: Record<string, any>,
  ref: Ref,
  label: string,
  contentKind?: string,
): void {
  assertRef(decodeRef(value.ref, `${label}.ref`), ref, label);
  if (!contentKind) return;
  const { ref: _ref, ...body } = value;
  assertRef(ref, contentRef(contentKind, body), label);
}

function decodeRef(value: unknown, label: string): Ref {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.sha256 !== "string" ||
    Object.keys(value).length !== 2) throw new Error(`${label} is invalid`);
  return { id: value.id, sha256: value.sha256 };
}

function assertRef(actual: Ref, expected: Ref, label: string): void {
  if (actual.id !== expected.id || actual.sha256 !== expected.sha256) {
    throw new Error(`Stopped finalization ${label} reference changed`);
  }
}

function assertSameJson(actual: unknown, expected: unknown, label: string): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`Stopped finalization ${label} changed`);
  }
}

function exactKeys(
  value: Record<string, any>,
  allowed: string[],
  label: string,
  optional = false,
): void {
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.includes(key)) ||
    (!optional && allowed.some((key) => !actual.includes(key)))) {
    throw new Error(`${label} shape changed`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
