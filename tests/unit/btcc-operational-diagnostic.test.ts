import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SqliteOperationalRecoveryStore } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/operational-recovery-store.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { migrateBtccSchema } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/migrate-schema.ts";
import { OperationalInterruptionError } from
  "../../packages/butler-agent/src/agent/btcc/index.ts";

test("runtime remediation retains its private diagnostic cause", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    migrateBtccSchema(db);
    const store = new SqliteOperationalRecoveryStore(db);
    await store.record(new OperationalInterruptionError(
      "runtime_unclassified_interruption",
      {
        turnId: "turn-diagnostic",
        turnRevision: 3,
        semanticState: "contract_review",
        checkpointId: "checkpoint-diagnostic",
        checkpointRevision: 5,
        claimId: "claim-diagnostic",
        executionFence: 0,
      },
      { kind: "runtime_remediation" },
      new Error("inactive Spec entered the current catalog"),
    ));

    const row = db.query<{ diagnostic_message: string }, []>(`
      SELECT diagnostic_message FROM btcc_operational_interruptions
    `).get();
    expect(row?.diagnostic_message)
      .toBe("Error: inactive Spec entered the current catalog");
  } finally {
    db.close();
  }
});
