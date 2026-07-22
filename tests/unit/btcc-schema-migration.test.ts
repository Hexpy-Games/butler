import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/open-btcc-sqlite-stores.ts";
import { BTCC_PHASE_CONVERSATION_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/phase-conversation-schema.ts";

test("opening an existing BTCC database migrates contention claim paths idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-schema-migration-"));
  const dbPath = join(root, "btcc.sqlite");
  const legacy = new Database(dbPath);
  legacy.exec(BTCC_PHASE_CONVERSATION_SCHEMA.replace("  claim_path TEXT NOT NULL,\n", ""));
  legacy.close();

  const first = openBtccSqliteStores({ dbPath, ownerId: "migration-owner-1" });
  first.close();
  const second = openBtccSqliteStores({ dbPath, ownerId: "migration-owner-2" });
  second.close();

  const migrated = new Database(dbPath);
  const claimPath = migrated.query<{ name: string; notnull: number; dflt_value: string }, []>(
    "PRAGMA table_info(btcc_ledger_contentions)",
  ).all().find((column) => column.name === "claim_path");
  expect(claimPath).toMatchObject({ name: "claim_path", notnull: 1, dflt_value: "''" });
  migrated.close();
  rmSync(root, { recursive: true, force: true });
});
