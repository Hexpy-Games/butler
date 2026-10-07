// Fixture-only attribution; queries copies so observation cannot dirty live SHM.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function idleSqliteEvidence(paths: string[], output: string): Record<string, string>[] {
  mkdirSync(output, { recursive: true });
  return paths.map((path, index) => {
    const copy = join(output, `${index}.sqlite`);
    copyFileSync(path, copy);
    if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
    const db = new Database(copy);
    try {
      const names = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
      return Object.fromEntries(names.map(({ name }) => {
        const rows = db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
        const hashes = rows.map(row => createHash("sha256").update(JSON.stringify(row, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value)).digest("hex")).sort();
        return [name, `${rows.length}:${createHash("sha256").update(hashes.join("\n")).digest("hex")}`];
      }));
    } finally { db.close(); }
  });
}
