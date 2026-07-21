import type { BtccPersistenceTypes } from "../../../btcc/gateway-api.ts";
import { stableJson } from "./identity.ts";
import { SqliteImmutableRecordStore } from "./immutable-record-store.ts";

type RepairTransition = Extract<
  BtccPersistenceTypes["transition"],
  { kind: "require_consolidation_repair" }
>;

export class ConsolidationRepairWriter {
  constructor(private readonly records: SqliteImmutableRecordStore) {}

  record(transition: RepairTransition): void {
    this.insert("consolidation_finding_set", transition.product.repair.findingSet);
    this.insert("correction_scope", transition.product.repair.correctionScope);
    this.insert("consolidation_repair", transition.product.repair);
  }

  private insert<T extends { ref: { id: string; sha256: string } }>(
    kind: string,
    value: T,
  ): void {
    this.records.insert(value.ref.id, kind, value.ref.sha256, stableJson(value));
  }
}
