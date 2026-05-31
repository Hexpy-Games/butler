// CLI: bun run query.ts --question "..." [--project name] [--days 14]
import * as lancedb from "@lancedb/lancedb";
import { readFileSync, appendFileSync, existsSync } from "fs";
import { join } from "path";
import { embed } from "./embed.ts";
import { readHotCache } from "./query-hot.ts";
import { BUTLER_DIR } from "./constants.ts";

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const DB_PATH = join(BUTLER_DIR.MEMORY, "db", "butler.lance");
const HOT_DIR = join(BUTLER_DIR.MEMORY, "hot");
const LOG_FILE = join(BUTLER_DIR.LOGS, "memory.log");

const args = process.argv.slice(2);
const question = getArg(args, "--question") ?? "";
const projectFilter = getArg(args, "--project") ?? null;
const daysRaw = getArg(args, "--days");
const days = daysRaw ? parseInt(daysRaw) : null;

if (!question) { console.error("--question required"); process.exit(1); }

const rawKeywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 1);
// Generate prefix substrings for Korean compound word matching
// Only decompose keywords with 4+ chars to avoid false positives from short common words
// e.g., "birthday" (8) → ["birthday", "birthda", "birthd", "birth"]
// e.g., "app" (3) → ["app"] (no decomposition, prevents false positives from short common words)
const keywords: string[] = [];
for (const kw of rawKeywords) {
  keywords.push(kw);
  if (kw.length >= 4) {
    for (let len = kw.length - 1; len >= 2; len--) {
      keywords.push(kw.slice(0, len));
    }
  }
}
const keywordSet = [...new Set(keywords)];

// L2 Hot Cache search (with 50KB size cap — see query-hot.ts)
const hotResults: string[] = readHotCache(HOT_DIR, keywordSet).map(r => r.text);

// Graph entity lookup (sync, graceful — empty DB returns empty results)
let graphSessionIds: string[] = [];
try {
  const { findEntities, getRelated, getEntitySessions } = await import("./graph.ts");
  const matches = findEntities(question);
  const allEntityIds = new Set<string>(matches.map((e: { id: string }) => e.id));
  for (const entity of matches.slice(0, 3)) {
    const related = getRelated(entity.id, 1);
    for (const r of related) allEntityIds.add(r.id);
  }
  graphSessionIds = getEntitySessions([...allEntityIds]);
} catch {
  // graph unavailable or DB not yet populated — skip silently
}

// LanceDB vector search + graph session fetch
type VecRow = { id: string; text: string; project: string; type: string; session_id: string; timestamp: number; hot_score: number; vector: number[] };
let vecResults: VecRow[] = [];
let graphResults: VecRow[] = [];
let table: lancedb.Table;

try {
  const db = await lancedb.connect(DB_PATH);
  table = await db.openTable("butler_memory");

  let skipVector = false;
  const queryVector = await embed(question);
  if (!queryVector || queryVector.length === 0) {
    if (!queryVector) process.stderr.write("WARNING: embed-server unavailable — vector search skipped\n");
    skipVector = true;
  }

  // Vector search (skipped if embed-server is down or returned empty)
  let results: any[] = [];
  if (!skipVector) {
    results = await table.search(queryVector!).limit(5).toArray();
  }

  // Post-process filters
  if (projectFilter) results = results.filter((r: any) => r.project === projectFilter);
  if (days) {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    results = results.filter((r: any) => r.timestamp >= cutoff);
  }

  vecResults = results;

  // Graph session fetch: pull sessions referenced by graph but not already in vecResults
  if (graphSessionIds.length > 0 && !skipVector) {
    const vecSessionSet = new Set(vecResults.map(r => r.session_id));
    const newSids = graphSessionIds
      .filter(sid => !vecSessionSet.has(sid))
      .slice(0, 5);
    if (newSids.length > 0) {
      try {
        const whereClause = newSids
          .map(sid => `session_id = '${sid.replace(/'/g, "''")}'`)
          .join(" OR ");
        const gRows = await table.search(queryVector!).where(whereClause).limit(5).toArray();
        graphResults = gRows;
      } catch {
        // filter query failed — skip
      }
    }
  }

  // Update hot_score for top vector results
  for (const r of vecResults.slice(0, 3)) {
    const newScore = (r.hot_score ?? 0) + 1;
    const safeId = r.id.replace(/'/g, "''");
    await table.update({ where: `id = '${safeId}'`, values: { hot_score: newScore } });

    // Promote to L2 if hot_score >= 3
    if (newScore >= 3) {
      const today = new Date().toISOString().slice(0, 10);
      const hotFile = join(HOT_DIR, `${today}.md`);
      const marker = `[promoted] ${r.project} | ${r.session_id}`;
      const existing = existsSync(hotFile) ? readFileSync(hotFile, "utf8") : "";
      if (!existing.includes(marker)) {
        const entry = `\n## ${marker}\n${r.text.slice(0, 500)}\n`;
        appendFileSync(hotFile, entry);
      }
    }
  }
} catch (err: any) {
  if (!err.message?.includes("does not exist") && !err.message?.includes("was not found")) {
    process.stderr.write(`# Warning: LanceDB query failed (${err.message})\n`);
  }
}

// Output
console.log(`## Memory Results for: "${question}"\n`);

if (hotResults.length > 0) {
  console.log("### Hot Cache (L2) [source: hot]");
  console.log(hotResults.join("\n---\n"));
  console.log();
}

if (vecResults.length > 0) {
  console.log("### Search Results [source: vector]");
  for (const r of vecResults) {
    const date = new Date(r.timestamp * 1000).toISOString().slice(0, 10);
    console.log(`\n**[${r.session_id}] ${r.project} | ${r.type} | ${date}**`);
    console.log(r.text.slice(0, 1000));
  }
  console.log();
}

if (graphResults.length > 0) {
  console.log("### Graph Results [source: graph]");
  for (const r of graphResults) {
    const date = new Date(r.timestamp * 1000).toISOString().slice(0, 10);
    console.log(`\n**[${r.session_id}] ${r.project} | ${r.type} | ${date}**`);
    console.log(r.text.slice(0, 1000));
  }
  console.log();
}

if (hotResults.length === 0 && vecResults.length === 0 && graphResults.length === 0) {
  console.log("No related memories found.");
}

// Log
const logEntry = `[${new Date().toISOString().slice(0, 19).replace("T", " ")}] query.ts | question="${question.slice(0, 50)}" project=${projectFilter ?? "all"} | hot=${hotResults.length} vec=${vecResults.length} graph=${graphResults.length}\n`;
appendFileSync(LOG_FILE, logEntry);
