// SQLite graph layer for butler memory system
// DB: $BUTLER_DATA/memory/db/graph.sqlite
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { BUTLER_DIR } from "./constants.ts";

const DB_DIR = join(BUTLER_DIR.MEMORY, "db");
const DB_PATH = join(DB_DIR, "graph.sqlite");

let _db: Database | null = null;

function getDb(): Database {
  if (_db) return _db;

  mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH);

  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA synchronous=NORMAL");

  _db.exec(`
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
  snippet TEXT
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_mentions_entity ON entity_mentions(entity_id);
CREATE INDEX IF NOT EXISTS idx_mentions_session ON entity_mentions(session_id);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
`);

  // Add new columns to entity_mentions if they don't exist yet
  try { _db.exec("ALTER TABLE entity_mentions ADD COLUMN source TEXT"); } catch {}
  try { _db.exec("ALTER TABLE entity_mentions ADD COLUMN project TEXT"); } catch {}

  return _db;
}

// Deterministic ID: sha256(type|name|project) for deduplication
function entityId(type: string, name: string, project?: string): string {
  const key = `${type}|${name.toLowerCase()}|${project ?? ""}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// Insert or update entity; returns its id
export function upsertEntity(
  type: string,
  name: string,
  project?: string,
  properties?: Record<string, unknown>,
): string {
  const id = entityId(type, name, project);
  const now = Math.floor(Date.now() / 1000);
  const props = JSON.stringify(properties ?? {});

  getDb().prepare(`
    INSERT INTO entities (id, type, name, project, properties, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = excluded.updated_at,
      properties = excluded.properties
  `).run(id, type, name, project ?? null, props, now, now);

  return id;
}

// Insert or update edge; increments weight on conflict
export function upsertEdge(
  sourceId: string,
  targetId: string,
  relType: string,
  sessionId?: string,
  properties?: Record<string, unknown>,
): void {
  const now = Math.floor(Date.now() / 1000);
  const props = JSON.stringify(properties ?? {});

  getDb().prepare(`
    INSERT INTO edges (source_id, target_id, rel_type, weight, properties, session_id, created_at)
    VALUES (?, ?, ?, 1.0, ?, ?, ?)
    ON CONFLICT(source_id, target_id, rel_type) DO UPDATE SET
      weight = weight + 1.0,
      session_id = excluded.session_id
  `).run(sourceId, targetId, relType, props, sessionId ?? null, now);
}

// Record that an entity was mentioned in a session
export function addMention(entityId: string, sessionId: string, snippet?: string, source?: string, project?: string): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    INSERT INTO entity_mentions (entity_id, session_id, timestamp, snippet, source, project)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(entityId, sessionId, now, snippet ?? null, source ?? null, project ?? null);
}

interface EntityRow {
  id: string;
  type: string;
  name: string;
  project: string | null;
  properties: string;
  hops: number;
}

// Breadth-first traversal via recursive CTE; returns entities within maxHops
export function getRelated(entityId: string, maxHops = 2): EntityRow[] {
  return getDb().prepare(`
    WITH RECURSIVE traversal(entity_id, hops) AS (
      SELECT ?, 0
      UNION
      SELECT e.target_id, t.hops + 1
      FROM traversal t
      JOIN edges e ON e.source_id = t.entity_id
      WHERE t.hops < ?
      UNION
      SELECT e.source_id, t.hops + 1
      FROM traversal t
      JOIN edges e ON e.target_id = t.entity_id
      WHERE t.hops < ?
    )
    SELECT DISTINCT en.id, en.type, en.name, en.project, en.properties,
           MIN(t.hops) as hops
    FROM traversal t
    JOIN entities en ON en.id = t.entity_id
    WHERE en.id != ?
    GROUP BY en.id
    ORDER BY hops ASC
  `).all(entityId, maxHops, maxHops, entityId) as EntityRow[];
}

interface FindResult {
  id: string;
  type: string;
  name: string;
  project: string | null;
  properties: string;
}

// Simple LIKE-based name search; optionally filter by type and/or project
export function findEntities(query: string, type?: string, project?: string): FindResult[] {
  const pattern = `%${query.toLowerCase()}%`;
  if (type && project) {
    return getDb().prepare(`
      SELECT id, type, name, project, properties
      FROM entities
      WHERE lower(name) LIKE ? AND type = ? AND project = ?
      LIMIT 20
    `).all(pattern, type, project) as FindResult[];
  }
  if (type) {
    return getDb().prepare(`
      SELECT id, type, name, project, properties
      FROM entities
      WHERE lower(name) LIKE ? AND type = ?
      LIMIT 20
    `).all(pattern, type) as FindResult[];
  }
  if (project) {
    return getDb().prepare(`
      SELECT id, type, name, project, properties
      FROM entities
      WHERE lower(name) LIKE ? AND project = ?
      LIMIT 20
    `).all(pattern, project) as FindResult[];
  }
  return getDb().prepare(`
    SELECT id, type, name, project, properties
    FROM entities
    WHERE lower(name) LIKE ?
    LIMIT 20
  `).all(pattern) as FindResult[];
}

interface MentionRow {
  entity_id: string;
  session_id: string;
  timestamp: number;
  snippet: string | null;
  source: string | null;
  project: string | null;
  entity_name: string;
  entity_type: string;
}

// Return mentions for given session IDs (links graph nodes back to LanceDB chunks)
export function getRecentMentions(sessionIds: string[]): MentionRow[] {
  if (sessionIds.length === 0) return [];
  // Build parameterized placeholders
  const placeholders = sessionIds.map(() => "?").join(",");
  return getDb().prepare(`
    SELECT m.entity_id, m.session_id, m.timestamp, m.snippet, m.source, m.project,
           e.name as entity_name, e.type as entity_type
    FROM entity_mentions m
    JOIN entities e ON e.id = m.entity_id
    WHERE m.session_id IN (${placeholders})
    ORDER BY m.timestamp DESC
  `).all(...sessionIds) as MentionRow[];
}

// Return unique session IDs that mentioned any of the given entity IDs
export function getEntitySessions(entityIds: string[]): string[] {
  if (entityIds.length === 0) return [];
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = getDb().prepare(`
    SELECT DISTINCT session_id
    FROM entity_mentions
    WHERE entity_id IN (${placeholders})
    ORDER BY timestamp DESC
    LIMIT 20
  `).all(...entityIds) as { session_id: string }[];
  return rows.map(r => r.session_id);
}
