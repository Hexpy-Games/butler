import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { PromptAssembler } from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import type { StoredSessionBinding } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { importLegacyMemory } from "../../packages/butler-agent/src/agent/cognition/memory/legacy-import.ts";
import { recallMemoryEvidence } from "../../packages/butler-agent/src/agent/cognition/memory/quality.ts";

let tempDir = "";
let legacyRoot = "";
let butlerData = "";

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-legacy-import-${Date.now()}-${Math.random()}`);
  legacyRoot = join(tempDir, "legacy", "memory");
  butlerData = join(tempDir, "data");
  mkdirSync(legacyRoot, { recursive: true });
  mkdirSync(butlerData, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createLegacyFixture(): void {
  mkdirSync(join(legacyRoot, "rules", "feedback"), { recursive: true });
  mkdirSync(join(legacyRoot, "projects"), { recursive: true });
  mkdirSync(join(legacyRoot, "hot"), { recursive: true });
  mkdirSync(join(legacyRoot, "db"), { recursive: true });
  writeFileSync(join(legacyRoot, "user-profile.md"), "Prefers concise Korean reports.\n", "utf8");
  writeFileSync(join(legacyRoot, "rules", "feedback", "verify.md"), "Always verify before final reports.\n", "utf8");
  writeFileSync(join(legacyRoot, "projects", "butler.md"), "Search provider decision is DuckDuckGo default.\n", "utf8");
  writeFileSync(join(legacyRoot, "hot", "cache.md"), "Hot note: user likes short status updates.\n", "utf8");

  const db = new Database(join(legacyRoot, "db", "graph.sqlite"));
  db.exec(`
    CREATE TABLE entities (
      id TEXT PRIMARY KEY,
      type TEXT,
      name TEXT,
      project TEXT,
      properties TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT,
      target_id TEXT,
      rel_type TEXT,
      weight REAL,
      properties TEXT,
      session_id TEXT,
      created_at INTEGER,
      UNIQUE(source_id, target_id, rel_type)
    );
    CREATE TABLE entity_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT,
      session_id TEXT,
      timestamp INTEGER,
      snippet TEXT,
      source TEXT,
      project TEXT
    );
    INSERT INTO entities VALUES ('duck', 'decision', 'DuckDuckGo search provider', 'butler', '{}', 1, 1);
    INSERT INTO entities VALUES ('search', 'entity', 'search provider', 'butler', '{}', 1, 1);
    INSERT INTO edges (source_id, target_id, rel_type, weight, properties, session_id, created_at)
      VALUES ('search', 'duck', 'decided', 1.0, '{}', 'legacy-session', 1);
    INSERT INTO entity_mentions (entity_id, session_id, timestamp, snippet, source, project)
      VALUES ('duck', 'legacy-session', 1777210000, 'DuckDuckGo was chosen as the default search provider.', 'legacy', 'butler');
  `);
  db.close();
}

test("legacy memory import dry-run reports counts without writing", () => {
  createLegacyFixture();

  const result = importLegacyMemory({
    legacyMemoryRoot: legacyRoot,
    butlerData,
    dryRun: true,
  });

  expect(result.counts).toMatchObject({
    profile: 0,
    rules: 1,
    projects: 1,
    hotCache: 1,
    graphEntities: 2,
    graphEdges: 1,
    graphMentions: 1,
  });
  expect(existsSync(join(butlerData, "cognition", "memory", "user-profile.md"))).toBe(false);
});

test("legacy memory import applies idempotently and makes memories recallable", () => {
  createLegacyFixture();

  const first = importLegacyMemory({
    legacyMemoryRoot: legacyRoot,
    butlerData,
    dryRun: false,
  });
  const second = importLegacyMemory({
    legacyMemoryRoot: legacyRoot,
    butlerData,
    dryRun: false,
  });

  expect(first.counts.profile).toBe(0);
  expect(first.counts.rules).toBe(1);
  expect(first.counts.projects).toBe(1);
  expect(first.counts.graphEntities).toBe(2);
  expect(second.counts.profile).toBe(0);
  expect(second.counts.rules).toBe(0);
  expect(second.counts.projects).toBe(0);
  expect(second.counts.skippedDuplicates).toBeGreaterThan(0);

  expect(existsSync(join(butlerData, "cognition", "memory", "user-profile.md"))).toBe(false);
  const ruleIndex = readFileSync(join(butlerData, "cognition", "memory", "rules", "INDEX.md"), "utf8");
  expect(ruleIndex).toContain("legacy/feedback/verify.md");
  const projectMemory = readFileSync(join(butlerData, "cognition", "memory", "projects", "butler.md"), "utf8");
  expect(projectMemory).toContain("# Project Memory: butler");
  expect(projectMemory).toContain("Search provider decision is DuckDuckGo default");

  const queried = recallMemoryEvidence({
    butlerData,
    cue: "DuckDuckGo search provider",
  });
  expect(queried.abstained).toBe(false);
  expect(queried.items.some((item) => item.provenance.includes("graph:legacy-butler-import:legacy-session"))).toBe(true);
  expect(queried.results.some((item) => item.source === "project-memory")).toBe(true);
});

test("imported rules appear in prompt assembly while legacy profile is ignored", () => {
  createLegacyFixture();
  importLegacyMemory({
    legacyMemoryRoot: legacyRoot,
    butlerData,
    dryRun: false,
  });

  const assembler = new PromptAssembler({
    butlerHome: "fixtures/butler-project",
    butlerData,
  });
  const binding: StoredSessionBinding = {
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    lifecycleState: "active",
    runtimeAdapterId: "native-tool-loop",
    modelProviderId: "fake",
    modelRef: "openai/auto:codex-latest",
    transportBindings: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const assembled = assembler.buildSystemPrompt(binding);
  const turnContext = assembler.buildTurnContext({
    binding,
    envelope: {
      eventId: "legacy-import-rules",
      transport: "mock",
      accountId: "default",
      peer: { kind: "dm", id: "peer-1" },
      sender: { id: "user-1" },
      message: {
        id: "msg-1",
        text: "continue",
        timestamp: new Date().toISOString(),
      },
    },
  });

  expect(assembled.systemPrompt).not.toContain("Prefers concise Korean reports");
  expect(assembled.systemPrompt).not.toContain("Always verify before final reports");
  expect(turnContext).toContain("Always verify before final reports");
});

test("legacy graph import failures rollback partial graph writes", () => {
  mkdirSync(join(legacyRoot, "db"), { recursive: true });
  const source = new Database(join(legacyRoot, "db", "graph.sqlite"));
  source.exec(`
    CREATE TABLE entities (
      id TEXT PRIMARY KEY,
      type TEXT,
      name TEXT,
      project TEXT,
      properties TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    INSERT INTO entities VALUES ('partial', 'decision', 'Partial Import', 'butler', '{}', 1, 1);
  `);
  source.close();

  expect(() => importLegacyMemory({
    legacyMemoryRoot: legacyRoot,
    butlerData,
    dryRun: false,
  })).toThrow();

  const target = new Database(join(butlerData, "cognition", "memory", "db", "graph.sqlite"), { readonly: true });
  try {
    const count = target.prepare("SELECT COUNT(*) AS count FROM entities").get() as { count: number };
    expect(count.count).toBe(0);
  } finally {
    target.close();
  }
});
