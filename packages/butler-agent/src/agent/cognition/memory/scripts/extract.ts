// Rule-based entity/relationship extraction from conversation text (<10ms target)
// Reads known project names from Butler config at startup.
import { readFileSync } from "fs";
import { join } from "path";
import { upsertEntity, upsertEdge, addMention } from "./graph.ts";
import { BUTLER_DIR } from "./constants.ts";
import { DECISION_PATTERNS, CONCEPT_PATTERNS, INTEREST_PATTERNS } from "./locales/index.ts";
import { KNOWN_TOOLS } from "./config.ts";

// ---------------------------------------------------------------------------
// Known entity catalogs
// ---------------------------------------------------------------------------

function loadProjectNames(): string[] {
  try {
    const config = JSON.parse(readFileSync(join(BUTLER_DIR.DATA, "butler.config.json"), "utf8"));
    const projects = Array.isArray(config.projects) ? config.projects : Object.values(config.projects ?? {});
    return (projects as any[])
      .map((project) => project?.name)
      .filter((name): name is string => typeof name === "string" && name.length > 1);
  } catch {
    return [];
  }
}

const KNOWN_PROJECTS = loadProjectNames();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedEntity {
  type: string;
  name: string;
  project?: string;
}

export interface ExtractedEdge {
  sourceType: string;
  sourceName: string;
  targetType: string;
  targetName: string;
  relType: string;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  edges: ExtractedEdge[];
}

// ---------------------------------------------------------------------------
// Extraction logic
// ---------------------------------------------------------------------------

export function extractEntities(
  text: string,
  sessionId: string,
  project?: string,
): ExtractionResult {
  const entities: ExtractedEntity[] = [];
  const edges: ExtractedEdge[] = [];
  const seen = new Set<string>(); // dedup within one call

  function addEntity(type: string, name: string, proj?: string) {
    const key = `${type}|${name}`;
    if (!seen.has(key)) {
      seen.add(key);
      entities.push({ type, name, project: proj });
    }
  }

  // --- Projects ---
  for (const proj of KNOWN_PROJECTS) {
    // Case-insensitive, word-boundary aware (handles snake_case names)
    const escaped = proj.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i");
    if (re.test(text)) {
      addEntity("project", proj);
    }
  }

  // If caller provided a project, always include it
  if (project && !seen.has(`project|${project}`)) {
    addEntity("project", project);
  }

  // --- Tools ---
  for (const tool of KNOWN_TOOLS) {
    const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i");
    if (re.test(text)) {
      addEntity("tool", tool, project);
    }
  }

  // --- Decisions ---
  let hasDecision = false;
  for (const pat of DECISION_PATTERNS) {
    pat.lastIndex = 0; // reset stateful regex
    if (pat.test(text)) { hasDecision = true; break; }
  }
  if (hasDecision) {
    // Emit a decision entity summarized from first 80 chars around the match
    const summary = text.slice(0, 80).replace(/\n/g, " ").trim();
    addEntity("decision", summary, project);

    // Link decision to project if known
    if (project) {
      edges.push({
        sourceType: "project", sourceName: project,
        targetType: "decision", targetName: summary,
        relType: "decided",
      });
    }
  }

  // --- Concepts ---
  for (const pat of CONCEPT_PATTERNS) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(text)) !== null) {
      const conceptName = m[1].trim();
      if (conceptName.length >= 2 && conceptName.length <= 40) {
        addEntity("concept", conceptName, project);
      }
    }
  }

  // --- Interests ---
  let hasInterest = false;
  for (const pat of INTEREST_PATTERNS) {
    pat.lastIndex = 0;
    if (pat.test(text)) { hasInterest = true; break; }
  }
  if (hasInterest && project) {
    edges.push({
      sourceType: "project", sourceName: project,
      targetType: "concept", targetName: "learning",
      relType: "interested_in",
    });
    addEntity("concept", "learning", project);
  }

  // --- Tool→Project edges ---
  // Any tool mentioned alongside a known project gets a "works_on" edge
  const projectEntities = entities.filter(e => e.type === "project");
  const toolEntities = entities.filter(e => e.type === "tool");
  for (const proj of projectEntities) {
    for (const tool of toolEntities) {
      edges.push({
        sourceType: "project", sourceName: proj.name,
        targetType: "tool", targetName: tool.name,
        relType: "works_on",
      });
    }
  }

  return { entities, edges };
}

// ---------------------------------------------------------------------------
// Extract + persist to SQLite graph
// ---------------------------------------------------------------------------

export function extractAndSave(
  text: string,
  sessionId: string,
  project?: string,
  source?: string,
): ExtractionResult {
  const result = extractEntities(text, sessionId, project);

  // Upsert entities and collect their IDs
  const idMap = new Map<string, string>(); // "type|name" → graph id
  for (const ent of result.entities) {
    const id = upsertEntity(ent.type, ent.name, ent.project);
    idMap.set(`${ent.type}|${ent.name}`, id);

    // Record mention for cross-linking with LanceDB
    const snippet = text.slice(0, 200).replace(/\n/g, " ").trim();
    addMention(id, sessionId, snippet, source, project);
  }

  // Upsert edges
  for (const edge of result.edges) {
    const srcId = idMap.get(`${edge.sourceType}|${edge.sourceName}`);
    const tgtId = idMap.get(`${edge.targetType}|${edge.targetName}`);
    if (srcId && tgtId) {
      upsertEdge(srcId, tgtId, edge.relType, sessionId);
    }
  }

  return result;
}
