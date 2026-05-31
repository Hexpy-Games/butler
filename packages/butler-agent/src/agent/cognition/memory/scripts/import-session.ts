// CLI: bun run import-session.ts <jsonl-path> [--project <name>] [--dry-run]
// Extracts conversations from Butler-owned transcript JSONL, then saves to hot cache + graph DB.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { basename, dirname, join } from "path";
import { homedir } from "os";
import { extractAndSave } from "./extract.ts";
import { BUTLER_DIR } from "./constants.ts";
import { cognitionMemoryRoot } from "../../paths.ts";
import { resolveProjectKey } from "./resolve-project.ts";
import { butlerAgentSourcePath } from "../../../../runtime/paths.ts";
import {
  chunkConversationByGap,
  parseConversationLogLines,
  renderConversationText,
  type ConversationChunk,
  type ConversationLogFormat,
  type ConversationMessage,
} from "./lib/conversation-sources.ts";
import { SessionBindingStore } from "../../../../test-support/harness/session-store.ts";

function butlerHome(): string {
  return process.env.BUTLER_HOME || BUTLER_DIR.HOME || process.cwd();
}

function butlerData(): string {
  return process.env.BUTLER_DATA || BUTLER_DIR.DATA || join(homedir(), ".butler");
}

function memoryDbDir(): string {
  return join(cognitionMemoryRoot(butlerData()), "db");
}

function importedFilePath(): string {
  return join(memoryDbDir(), "imported-sessions.txt");
}

function saveHotScriptPath(): string {
  return butlerAgentSourcePath(butlerHome(), "agent", "cognition", "memory", "scripts", "save_hot.ts");
}

export interface ImportPlan {
  format: ConversationLogFormat;
  sessionId: string;
  project: string;
  messages: ConversationMessage[];
  chunks: ConversationChunk[];
}

export interface RunImportSessionOptions {
  jsonlPath: string;
  projectOverride?: string;
  dryRun?: boolean;
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function resolveProjectFromSessionStore(sessionId: string): string | null {
  const storePath = join(butlerData(), "runtime", "session-store.sqlite");
  const store = new SessionBindingStore(storePath);
  try {
    return store.getBySessionId(sessionId)?.projectId ?? null;
  } finally {
    store.close();
  }
}

function resolveImportProject(
  jsonlPath: string,
  sessionId: string,
  format: ConversationLogFormat,
  projectOverride?: string,
): string {
  const directOverride = projectOverride?.trim();
  if (directOverride) {
    return resolveProjectKey(directOverride) ?? directOverride;
  }

  const storedProject = format === "butler-transcript"
    ? resolveProjectFromSessionStore(sessionId)
    : null;
  if (storedProject?.trim()) {
    return storedProject;
  }

  const pathHint = basename(dirname(jsonlPath));
  const resolvedPathHint = resolveProjectKey(pathHint);
  if (resolvedPathHint) return resolvedPathHint;
  if (pathHint && !pathHint.startsWith("-")) return pathHint;

  return resolveProjectKey("butler") ?? "butler";
}

function importedSessions(): Set<string> {
  const importedFile = importedFilePath();
  if (!existsSync(importedFile)) return new Set();
  return new Set(
    readFileSync(importedFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

export function buildImportPlan(
  jsonlPath: string,
  options: { projectOverride?: string } = {},
): ImportPlan {
  if (!existsSync(jsonlPath)) {
    throw new Error(`File not found: ${jsonlPath}`);
  }

  const lines = readFileSync(jsonlPath, "utf8")
    .split("\n")
    .filter((line) => line.trim());
  const parsed = parseConversationLogLines(lines);
  const sessionId = parsed.sessionId ?? basename(jsonlPath, ".jsonl");
  const project = resolveImportProject(
    jsonlPath,
    sessionId,
    parsed.format,
    options.projectOverride,
  );

  return {
    format: parsed.format,
    sessionId,
    project,
    messages: parsed.messages,
    chunks: chunkConversationByGap(parsed.messages),
  };
}

export function runImportSession(options: RunImportSessionOptions): number {
  mkdirSync(memoryDbDir(), { recursive: true });

  const plan = buildImportPlan(options.jsonlPath, {
    projectOverride: options.projectOverride,
  });
  if (plan.messages.length === 0) {
    console.log(`No conversation messages found in ${plan.sessionId}`);
    return 0;
  }

  if (importedSessions().has(plan.sessionId)) {
    console.log(`Already imported: ${plan.sessionId}`);
    return 0;
  }

  console.log(`Parsed ${plan.messages.length} messages from session ${plan.sessionId}`);
  console.log(`Split into ${plan.chunks.length} chunks`);

  let savedCount = 0;
  let graphCount = 0;

  for (let index = 0; index < plan.chunks.length; index += 1) {
    const chunk = plan.chunks[index];
    const chunkId = `${plan.sessionId}_chunk${index}`;
    const conversationText = renderConversationText(chunk.messages);
    if (!conversationText.trim()) continue;

    const maxLen = 8000;
    const truncated = conversationText.length > maxLen
      ? `${conversationText.slice(0, maxLen)}\n...(truncated)`
      : conversationText;

    if (options.dryRun) {
      console.log(
        `\n--- Chunk ${index} (${chunk.messages.length} msgs, ${chunk.startTime} ~ ${chunk.endTime}) ---`,
      );
      console.log(`${truncated.slice(0, 300)}...`);
      continue;
    }

    const result = spawnSync(
      process.execPath,
      [
        "run",
        saveHotScriptPath(),
        "--project",
        plan.project,
        "--session-id",
        chunkId,
        "--type",
        "conversation",
      ],
      {
        input: truncated,
        encoding: "utf8",
        timeout: 120000,
      },
    );

    if (result.status === 0) {
      savedCount += 1;
      console.log(`  Chunk ${index}: saved to hot cache (${chunk.messages.length} msgs)`);
    } else {
      console.error(`  Chunk ${index}: save_hot failed — ${result.stderr?.slice(0, 200)}`);
    }

    try {
      const extracted = extractAndSave(conversationText, chunkId, plan.project);
      graphCount += extracted.entities.length;
      if (extracted.entities.length > 0) {
        console.log(
          `  Chunk ${index}: ${extracted.entities.length} entities, ${extracted.edges.length} edges`,
        );
      }
    } catch (error: any) {
      console.error(`  Chunk ${index}: extract failed — ${error.message}`);
    }
  }

  if (!options.dryRun) {
    appendFileSync(importedFilePath(), `${plan.sessionId}\n`);
    console.log(`\nDone: ${savedCount} chunks saved, ${graphCount} entities extracted`);
    console.log(`Session ${plan.sessionId} marked as imported`);
  }

  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const jsonlPath = args.find((arg) => !arg.startsWith("--"));
  if (!jsonlPath) {
    console.error("Usage: bun run import-session.ts <jsonl-path> [--project <name>] [--dry-run]");
    process.exit(1);
  }

  try {
    process.exit(
      runImportSession({
        jsonlPath,
        projectOverride: getArg(args, "--project"),
        dryRun: args.includes("--dry-run"),
      }),
    );
  } catch (error: any) {
    console.error(error?.message ?? String(error));
    process.exit(1);
  }
}
