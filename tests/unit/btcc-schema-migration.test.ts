import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/open-btcc-sqlite-stores.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";

test("opening an existing R3 database migrates Work import provenance idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-schema-migration-"));
  const dbPath = join(root, "btcc.sqlite");
  const legacy = new Database(dbPath);
  legacy.exec(BTCC_SUCCESSOR_SCHEMA
    .replace(
      "  source_authority TEXT NOT NULL CHECK (\n" +
      "    source_authority IN ('session_sqlite', 'project_ledger')\n" +
      "  ),\n  source_revision TEXT NOT NULL,\n",
      "",
    ));
  legacy.close();

  const first = openBtccSqliteStores({ dbPath, ownerId: "migration-owner-1" });
  first.close();
  const second = openBtccSqliteStores({ dbPath, ownerId: "migration-owner-2" });
  second.close();

  const migrated = new Database(dbPath);
  const importColumns = migrated.query<{
    name: string;
    notnull: number;
    dflt_value: string;
  }, []>("PRAGMA table_info(btcc_guided_work_legacy_imports)").all();
  expect(importColumns.find((column) => column.name === "source_authority"))
    .toMatchObject({ notnull: 1, dflt_value: "'session_sqlite'" });
  expect(importColumns.find((column) => column.name === "source_revision"))
    .toMatchObject({ notnull: 1, dflt_value: "'unknown'" });
  migrated.close();
  rmSync(root, { recursive: true, force: true });
});
