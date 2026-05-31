// One-shot migration: rewrite butler_memory.project to canonical registry keys.
//
// Usage:
//   bun run packages/butler-agent/src/agent/cognition/memory/scripts/migrate-project-keys.ts --dry-run
//   bun run packages/butler-agent/src/agent/cognition/memory/scripts/migrate-project-keys.ts --apply
//
// Behavior:
//   - Scans distinct project values in the butler_memory LanceDB table.
//   - For each value, runs resolveProjectKey (registry name/path + forward-encoded dirname).
//   - Dry-run: prints per-mapping counts (keep / rewrite / drop).
//   - Apply: performs UPDATE per rewrite group and DELETE per drop group.
//
// Requirements: a backup of the LanceDB table must exist before --apply.

import * as lancedb from "@lancedb/lancedb";
import { join } from "path";
import { existsSync } from "fs";
import { BUTLER_DIR } from "./constants.ts";
import { resolveProjectKey } from "./resolve-project.ts";

// Projects allowed to stay even if not currently rewritten by the resolver
// (i.e. they already equal a registry name and need no rewrite).
const PASS_THROUGH = new Set(["butler", "daangn-tracker", "pet-food-info"]);

interface Plan {
  keep: Map<string, number>; // value → count, already canonical
  rewrite: Map<string, { target: string; count: number }>;
  drop: Map<string, number>;
}

function sqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

async function buildPlan(table: lancedb.Table): Promise<Plan> {
  const rows = await table.query().select(["project"]).limit(1_000_000).toArray();
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = (r as any).project ?? "";
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }

  const plan: Plan = { keep: new Map(), rewrite: new Map(), drop: new Map() };
  for (const [value, count] of counts) {
    const resolved = resolveProjectKey(value);
    if (resolved && resolved === value) {
      plan.keep.set(value, count);
    } else if (resolved) {
      plan.rewrite.set(value, { target: resolved, count });
    } else if (PASS_THROUGH.has(value)) {
      // Not in resolver output but explicitly whitelisted (e.g. pet-food-info
      // which we keep untouched until project is actively touched).
      plan.keep.set(value, count);
    } else {
      plan.drop.set(value, count);
    }
  }
  return plan;
}

function printPlan(plan: Plan): { total: number; kept: number; rewritten: number; dropped: number } {
  console.log("=== Migration plan ===");
  let kept = 0, rewritten = 0, dropped = 0;

  const keepRows = [...plan.keep.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n-- KEEP (${plan.keep.size} distinct value(s)) --`);
  for (const [v, c] of keepRows) {
    console.log(`  ${JSON.stringify(v)} — ${c}`);
    kept += c;
  }

  const rewriteRows = [...plan.rewrite.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log(`\n-- REWRITE (${plan.rewrite.size} distinct value(s)) --`);
  for (const [v, info] of rewriteRows) {
    console.log(`  ${JSON.stringify(v)} → ${JSON.stringify(info.target)}  (${info.count})`);
    rewritten += info.count;
  }

  const dropRows = [...plan.drop.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n-- DROP (${plan.drop.size} distinct value(s)) --`);
  for (const [v, c] of dropRows) {
    console.log(`  ${JSON.stringify(v)} — ${c}`);
    dropped += c;
  }

  const total = kept + rewritten + dropped;
  console.log("\n=== Summary ===");
  console.log(`  keep:     ${kept}`);
  console.log(`  rewrite:  ${rewritten}`);
  console.log(`  drop:     ${dropped}`);
  console.log(`  total:    ${total}`);

  // Group rewrite targets
  const targetCounts = new Map<string, number>();
  for (const [, info] of plan.rewrite) {
    targetCounts.set(info.target, (targetCounts.get(info.target) ?? 0) + info.count);
  }
  if (targetCounts.size > 0) {
    console.log("\n-- Rewrite targets roll-up --");
    for (const [t, c] of targetCounts) {
      console.log(`  → ${JSON.stringify(t)}: +${c}`);
    }
  }

  return { total, kept, rewritten, dropped };
}

async function applyPlan(table: lancedb.Table, plan: Plan): Promise<void> {
  console.log("\n=== Applying migration ===");

  // DROP first (so we don't rewrite rows we're about to delete)
  for (const [value, count] of plan.drop) {
    const filter = `project = '${sqlEscape(value)}'`;
    console.log(`DELETE where ${filter}  (${count} rows)`);
    await table.delete(filter);
  }

  // REWRITE: UPDATE set project = <target> where project = <value>
  for (const [value, info] of plan.rewrite) {
    const filter = `project = '${sqlEscape(value)}'`;
    console.log(`UPDATE ${filter} set project = '${info.target}'  (${info.count} rows)`);
    await table.update({ where: filter, values: { project: info.target } });
  }

  console.log("Apply complete.");
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const apply = args.includes("--apply");

  if (dryRun === apply) {
    console.error("Must pass exactly one of --dry-run or --apply");
    process.exit(2);
  }

  const DB_PATH = join(BUTLER_DIR.MEMORY, "db", "butler.lance");
  const db = await lancedb.connect(DB_PATH);
  const table = await db.openTable("butler_memory");

  const plan = await buildPlan(table);
  const summary = printPlan(plan);

  if (dryRun) {
    console.log("\n(dry-run — no changes applied)");
    return;
  }

  // Apply requires a backup sibling dir to exist
  const BACKUP_GLOB = join(BUTLER_DIR.MEMORY, "db", "butler.lance.migrate-bak");
  if (!existsSync(BACKUP_GLOB)) {
    console.error(
      `\nRefusing to apply: expected backup directory at ${BACKUP_GLOB}`,
    );
    console.error(
      `Create it with: cp -R ${join(BUTLER_DIR.MEMORY, "db", "butler.lance")} ${BACKUP_GLOB}`,
    );
    process.exit(3);
  }

  await applyPlan(table, plan);

  // Verify post-state
  const after = await table.query().select(["project"]).limit(1_000_000).toArray();
  const distinct = new Map<string, number>();
  for (const r of after) {
    const v = (r as any).project ?? "";
    distinct.set(v, (distinct.get(v) ?? 0) + 1);
  }
  console.log("\n=== Post-migration distinct project values ===");
  const sorted = [...distinct.entries()].sort((a, b) => b[1] - a[1]);
  for (const [v, c] of sorted) {
    console.log(`  ${JSON.stringify(v)}: ${c}`);
  }

  const expectedTotal = summary.kept + summary.rewritten;
  const actualTotal = after.length;
  if (actualTotal !== expectedTotal) {
    console.error(
      `\nWARNING: post-migration row count (${actualTotal}) != expected (${expectedTotal})`,
    );
  } else {
    console.log(`\nRow count OK: ${actualTotal}`);
  }
}

await main();
