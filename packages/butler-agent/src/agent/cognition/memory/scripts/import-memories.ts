// CLI: bun run packages/butler-agent/src/agent/cognition/memory/scripts/import-memories.ts --input memories.txt
//      cat memories.txt | bun run packages/butler-agent/src/agent/cognition/memory/scripts/import-memories.ts
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { BUTLER_DIR } from "./constants.ts";
import { runPromptText } from "../../../../integrations/providers/provider.ts";

const PROJECTS_DIR = join(BUTLER_DIR.MEMORY, "projects");

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

// --- Parse input ---
interface RawMemory {
  date: string;
  content: string;
}

function parseInput(text: string): RawMemory[] {
  const entries: RawMemory[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^\[([^\]]+)\]\s*[–-]\s*(.+)$/);
    if (match) {
      entries.push({ date: match[1].trim(), content: match[2].trim() });
    }
  }
  return entries;
}

// --- Categorize via the configured runtime ---
interface CategorizedMemory {
  date: string;
  content: string;
  category: "project" | "persona-hint" | "skip";
  project?: string; // extracted project name for "project" category
}

async function categorize(entries: RawMemory[]): Promise<CategorizedMemory[]> {
  const prompt = `You are categorizing memories from a personal AI assistant import.

Classify each memory into exactly one category:
- "project": info about a specific software project (name, stack, status, goals)
- "persona-hint": behavioral instructions ("always respond in X", "never do Y", "use format Z")
- "skip": personal profile facts, shallow preferences, too vague, outdated, irrelevant, or purely ephemeral

For "project" entries, also extract the project name as a slug (e.g., "my-app", "web-api").

Return ONLY a valid JSON array, no markdown, no explanation:
[
  { "date": "...", "content": "...", "category": "...", "project": "slug or null" },
  ...
]

Memories to categorize:
${JSON.stringify(entries, null, 2)}`;

  // Strip potential markdown code fences
  let raw = "";
  try {
    raw = (await runPromptText({ prompt })).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("categorize failed:", message);
    process.exit(1);
  }
  const fence = raw.match(/```(?:json)?\n([\s\S]*?)\n```/);
  if (fence) raw = fence[1];

  try {
    return JSON.parse(raw);
  } catch {
    console.error("Failed to parse JSON from runtime output:");
    console.error(raw.slice(0, 500));
    process.exit(1);
  }
}

// --- Read existing content for dedup ---
function readExisting(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function alreadyPresent(existing: string, content: string): boolean {
  // Normalize whitespace for comparison
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return normalize(existing).includes(normalize(content));
}

// --- Append to project file ---
function appendProject(entries: CategorizedMemory[]): Map<string, number> {
  const counts = new Map<string, number>();

  // Group by project slug
  const byProject = new Map<string, CategorizedMemory[]>();
  for (const e of entries) {
    const slug = e.project ?? "unknown";
    if (!byProject.has(slug)) byProject.set(slug, []);
    byProject.get(slug)!.push(e);
  }

  for (const [slug, items] of byProject) {
    const filePath = join(PROJECTS_DIR, `${slug}.md`);
    const existing = readExisting(filePath);
    const newLines: string[] = [];

    for (const e of items) {
      if (alreadyPresent(existing, e.content)) continue;
      newLines.push(`- [${e.date}] ${e.content}`);
    }

    if (newLines.length === 0) {
      counts.set(slug, 0);
      continue;
    }

    const block = "\n## Imported Notes\n" + newLines.join("\n") + "\n";
    if (!existing) {
      // New project file
      const header = `---\nname: ${slug}\ndescription: Imported from memory dump\ntype: project\n---\n\n# ${slug}\n`;
      writeFileSync(filePath, header + block);
    } else if (!existing.includes("## Imported Notes")) {
      writeFileSync(filePath, existing + block);
    } else {
      writeFileSync(filePath, existing + newLines.join("\n") + "\n");
    }

    counts.set(slug, newLines.length);
  }

  return counts;
}

// --- Main ---
const args = process.argv.slice(2);
const inputFile = getArg(args, "--input");

let raw: string;
if (inputFile) {
  if (!existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
  }
  raw = readFileSync(inputFile, "utf8");
} else {
  raw = await Bun.stdin.text();
}

if (!raw.trim()) {
  console.error("No input provided.");
  process.exit(1);
}

const entries = parseInput(raw);
if (entries.length === 0) {
  console.error("No parseable memory entries found. Expected format: [date] – content");
  process.exit(1);
}

console.log(`Parsed ${entries.length} entries. Categorizing memories...`);

const categorized = await categorize(entries);

const projectEntries = categorized.filter((e) => e.category === "project");
const personaHints = categorized.filter((e) => e.category === "persona-hint");
const skipped = categorized.filter((e) => e.category === "skip");

const projectCounts = appendProject(projectEntries);

// Summary
console.log("\n── Import Summary ──────────────────────────");

for (const [slug, count] of projectCounts) {
  console.log(`project/${slug}: ${count} added`);
}
if (projectCounts.size === 0 && projectEntries.length > 0) {
  console.log("project      : 0 added (all duplicates)");
}

console.log(`skipped      : ${skipped.length}`);

if (personaHints.length > 0) {
  console.log("\n── Persona Hints (review manually) ─────────");
  for (const h of personaHints) {
    console.log(`  [${h.date}] ${h.content}`);
  }
  console.log("\nAdd these to your persona file if appropriate.");
}
