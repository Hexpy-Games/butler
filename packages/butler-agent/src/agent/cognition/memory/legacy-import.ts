import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, dirname, join, relative } from "path";
import { Database } from "bun:sqlite";
import { cognitionMemoryRoot } from "../paths.ts";
import { sanitizeProjectMemoryId } from "./project-memory.ts";

export interface LegacyImportCounts {
  profile: number;
  rules: number;
  projects: number;
  hotCache: number;
  graphEntities: number;
  graphEdges: number;
  graphMentions: number;
  skippedDuplicates: number;
}

export interface LegacyImportResult {
  ok: true;
  dryRun: boolean;
  source: string;
  target: string;
  provenance: "legacy-butler-import";
  counts: LegacyImportCounts;
}

function emptyCounts(): LegacyImportCounts {
  return {
    profile: 0,
    rules: 0,
    projects: 0,
    hotCache: 0,
    graphEntities: 0,
    graphEdges: 0,
    graphMentions: 0,
    skippedDuplicates: 0,
  };
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9가-힣._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "legacy-memory";
}

function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      out.push(...listMarkdownFiles(path));
      continue;
    }
    if (name.isFile() && name.name.endsWith(".md") && name.name !== "INDEX.md") out.push(path);
  }
  return out;
}

function writeFileIfMissing(input: {
  target: string;
  body: string;
  dryRun: boolean;
}): "added" | "duplicate" {
  const body = input.body.trim();
  if (!body) return "duplicate";
  const existing = readText(input.target);
  if (normalize(existing).includes(normalize(body))) return "duplicate";
  if (!input.dryRun) {
    mkdirSync(dirname(input.target), { recursive: true });
    writeFileSync(input.target, `${body}\n`, "utf8");
  }
  return "added";
}

function ensureGraphSchema(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  project TEXT,
  properties TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES entities(id),
  target_id TEXT NOT NULL REFERENCES entities(id),
  rel_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  properties TEXT DEFAULT '{}',
  session_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(source_id, target_id, rel_type)
);

CREATE TABLE IF NOT EXISTS entity_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  snippet TEXT,
  source TEXT,
  project TEXT
);
`);
  try { db.exec("ALTER TABLE entity_mentions ADD COLUMN source TEXT"); } catch {}
  try { db.exec("ALTER TABLE entity_mentions ADD COLUMN project TEXT"); } catch {}
}

function countTable(db: Database, table: string): number {
  if (!["entities", "edges", "entity_mentions"].includes(table)) {
    throw new Error(`unsupported graph table: ${table}`);
  }
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  } catch {
    return 0;
  }
}

function importGraph(input: {
  sourceDbPath: string;
  targetDbPath: string;
  dryRun: boolean;
  counts: LegacyImportCounts;
}): void {
  if (!existsSync(input.sourceDbPath)) return;
  const source = new Database(input.sourceDbPath, { readonly: true });
  try {
    if (input.dryRun) {
      input.counts.graphEntities += countTable(source, "entities");
      input.counts.graphEdges += countTable(source, "edges");
      input.counts.graphMentions += countTable(source, "entity_mentions");
      return;
    }

    mkdirSync(dirname(input.targetDbPath), { recursive: true });
    const target = new Database(input.targetDbPath);
    try {
      ensureGraphSchema(target);
      target.exec("BEGIN IMMEDIATE");
      const entities = source.prepare("SELECT id, type, name, project, properties, created_at, updated_at FROM entities").all() as Array<Record<string, any>>;
      for (const entity of entities) {
        const id = `legacy:${entity.id}`;
        const result = target.prepare(`
          INSERT OR IGNORE INTO entities (id, type, name, project, properties, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          entity.type,
          entity.name,
          entity.project ?? null,
          entity.properties ?? "{}",
          entity.created_at ?? Math.floor(Date.now() / 1000),
          entity.updated_at ?? Math.floor(Date.now() / 1000),
        );
        if (result.changes > 0) input.counts.graphEntities += 1;
        else input.counts.skippedDuplicates += 1;
      }

      const edges = source.prepare("SELECT source_id, target_id, rel_type, weight, properties, session_id, created_at FROM edges").all() as Array<Record<string, any>>;
      for (const edge of edges) {
        const result = target.prepare(`
          INSERT OR IGNORE INTO edges (source_id, target_id, rel_type, weight, properties, session_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          `legacy:${edge.source_id}`,
          `legacy:${edge.target_id}`,
          edge.rel_type,
          edge.weight ?? 1,
          edge.properties ?? "{}",
          edge.session_id ? `legacy-butler-import:${edge.session_id}` : "legacy-butler-import",
          edge.created_at ?? Math.floor(Date.now() / 1000),
        );
        if (result.changes > 0) input.counts.graphEdges += 1;
        else input.counts.skippedDuplicates += 1;
      }

      const mentions = source.prepare("SELECT entity_id, session_id, timestamp, snippet, source, project FROM entity_mentions").all() as Array<Record<string, any>>;
      for (const mention of mentions) {
        const entityId = `legacy:${mention.entity_id}`;
        const sessionId = `legacy-butler-import:${mention.session_id ?? "unknown"}`;
        const snippet = mention.snippet ?? "";
        const existing = target.prepare(`
          SELECT 1 FROM entity_mentions
          WHERE entity_id = ? AND session_id = ? AND IFNULL(snippet, '') = ?
          LIMIT 1
        `).get(entityId, sessionId, snippet);
        if (existing) {
          input.counts.skippedDuplicates += 1;
          continue;
        }
        target.prepare(`
          INSERT INTO entity_mentions (entity_id, session_id, timestamp, snippet, source, project)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          entityId,
          sessionId,
          mention.timestamp ?? Math.floor(Date.now() / 1000),
          snippet,
          "legacy-butler-import",
          mention.project ?? null,
        );
        input.counts.graphMentions += 1;
      }
      target.exec("COMMIT");
    } catch (error) {
      try { target.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      target.close();
    }
  } finally {
    source.close();
  }
}

function addRuleIndex(input: { butlerData: string; relativeTarget: string; title: string; dryRun: boolean }): void {
  if (input.dryRun) return;
  const indexPath = join(cognitionMemoryRoot(input.butlerData), "rules", "INDEX.md");
  const existing = readText(indexPath);
  const line = `- [${input.title}](${input.relativeTarget})\n`;
  if (existing.includes(`](${input.relativeTarget})`)) return;
  mkdirSync(dirname(indexPath), { recursive: true });
  appendFileSync(indexPath, line, "utf8");
}

export function importLegacyMemory(input: {
  legacyMemoryRoot: string;
  butlerData: string;
  dryRun?: boolean;
}): LegacyImportResult {
  const dryRun = input.dryRun !== false;
  const counts = emptyCounts();

  for (const sourcePath of listMarkdownFiles(join(input.legacyMemoryRoot, "rules"))) {
    const rel = relative(join(input.legacyMemoryRoot, "rules"), sourcePath);
    const targetRel = join("legacy", rel);
    const body = readText(sourcePath);
    const status = writeFileIfMissing({
      target: join(cognitionMemoryRoot(input.butlerData), "rules", targetRel),
      body: `${body.trim()}\n\nProvenance: legacy-butler-import`,
      dryRun,
    });
    if (status === "added") {
      counts.rules += 1;
      addRuleIndex({
        butlerData: input.butlerData,
        relativeTarget: targetRel,
        title: `legacy/${basename(sourcePath, ".md")}`,
        dryRun,
      });
    } else {
      counts.skippedDuplicates += 1;
    }
  }

  for (const sourcePath of listMarkdownFiles(join(input.legacyMemoryRoot, "projects"))) {
    const body = readText(sourcePath);
    const projectId = sanitizeProjectMemoryId(slug(basename(sourcePath, ".md")));
    const target = join(cognitionMemoryRoot(input.butlerData), "projects", `${projectId}.md`);
    const status = writeFileIfMissing({
      target,
      body: [
        `# Project Memory: ${projectId}`,
        "",
        "## Identity",
        `- project_id: ${projectId}`,
        "- source: legacy-butler-import",
        "",
        "## Legacy Notes",
        body.trim(),
        "",
        "## Freshness",
        "- provenance: legacy-butler-import",
      ].join("\n"),
      dryRun,
    });
    if (status === "added") counts.projects += 1;
    else counts.skippedDuplicates += 1;
  }

  for (const sourcePath of listMarkdownFiles(join(input.legacyMemoryRoot, "hot"))) {
    const body = readText(sourcePath);
    const target = join(cognitionMemoryRoot(input.butlerData), "hot", `legacy-${slug(basename(sourcePath, ".md"))}.md`);
    const status = writeFileIfMissing({
      target,
      body: `${body.trim()}\n\nProvenance: legacy-butler-import`,
      dryRun,
    });
    if (status === "added") counts.hotCache += 1;
    else counts.skippedDuplicates += 1;
  }

  importGraph({
    sourceDbPath: join(input.legacyMemoryRoot, "db", "graph.sqlite"),
    targetDbPath: join(cognitionMemoryRoot(input.butlerData), "db", "graph.sqlite"),
    dryRun,
    counts,
  });

  return {
    ok: true,
    dryRun,
    source: input.legacyMemoryRoot,
    target: cognitionMemoryRoot(input.butlerData),
    provenance: "legacy-butler-import",
    counts,
  };
}
