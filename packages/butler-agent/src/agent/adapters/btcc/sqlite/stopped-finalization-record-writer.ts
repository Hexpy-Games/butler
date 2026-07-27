import type { Database } from "bun:sqlite";
import type {
  FinalizationContinuation,
  FinalDossierProduct,
} from "../../../btcc/gateway-api.ts";
import { stableJson } from "./identity.ts";

type Ref = { id: string; sha256: string };

export function preserveStoppedFinalizationRecords(
  db: Database,
  managedStateJson: string | null,
  finalization: FinalizationContinuation,
): void {
  if (finalization.resumeAt === "reporting") {
    preserveFinalDossier(db, finalization.finalDossier);
    return;
  }
  if (finalization.resumeAt !== "delivery") return;
  insertImmutable(db, "prepared_report", finalization.preparedReport.report);
  insertImmutable(db, "final_payload", finalization.preparedReport.finalPayload);
  const managed = managedStateJson
    ? JSON.parse(managedStateJson) as { finalDossier?: unknown }
    : {};
  if (!isFinalDossierProduct(managed.finalDossier)) {
    throw new Error("Stopped Delivery continuation is missing its accepted FinalDossier");
  }
  preserveFinalDossier(db, managed.finalDossier);
}

function preserveFinalDossier(db: Database, product: FinalDossierProduct): void {
  if (product.assessment) insertImmutable(db, "consolidation_assessment", product.assessment);
  insertImmutable(db, "final_dossier", product.dossier);
}

function insertImmutable(db: Database, kind: string, value: { ref: Ref }): void {
  const json = stableJson(value);
  db.query(`
    INSERT OR IGNORE INTO btcc_records (record_id, kind, sha256, content_json)
    VALUES (?, ?, ?, ?)
  `).run(value.ref.id, kind, value.ref.sha256, json);
  const stored = db.query<{ kind: string; sha256: string; content_json: string }, [string]>(`
    SELECT kind, sha256, content_json FROM btcc_records WHERE record_id = ?
  `).get(value.ref.id);
  if (!stored || stored.kind !== kind || stored.sha256 !== value.ref.sha256 ||
    stored.content_json !== json) {
    throw new Error("Stopped finalization immutable record conflict");
  }
}

function isFinalDossierProduct(value: unknown): value is FinalDossierProduct {
  return isRecord(value) && value.kind === "final_dossier" && isRecord(value.dossier) &&
    isRecord(value.dossier.ref) && typeof value.dossier.ref.id === "string" &&
    typeof value.dossier.ref.sha256 === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
