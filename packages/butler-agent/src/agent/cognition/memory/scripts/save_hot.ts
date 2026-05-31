// CLI: echo "content" | bun run save_hot.ts --project name --session-id id [--type task|conversation|learning|play] [--project-path /abs/path] [--topic slug]
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { BUTLER_DIR, TWENTY_KB } from "./constants.ts";
import { runPromptText } from "../../../../integrations/providers/provider.ts";
import { butlerAgentSourcePath } from "../../../../runtime/paths.ts";

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

export type HotCacheMode = "topic" | "project" | "global";

export interface HotCachePath {
  file: string;
  mode: HotCacheMode;
}

// Minimal filesystem-safety sanitizer: only strip path separators and NUL.
// Korean and other unicode characters pass through unchanged (APFS/ext4 safe).
export function sanitizeTopicSlug(topic: string): string {
  return topic.replace(/[/\\\0]/g, "_");
}

export function resolveHotCachePath(opts: {
  topic?: string;
  projectPath?: string;
  memoryDir: string;
}): HotCachePath {
  if (opts.topic && opts.topic.trim()) {
    const slug = sanitizeTopicSlug(opts.topic.trim());
    return {
      file: join(opts.memoryDir, "hot", "topics", `${slug}.md`),
      mode: "topic",
    };
  }
  if (opts.projectPath) {
    return {
      file: join(opts.projectPath, ".butler", "hot-cache.md"),
      mode: "project",
    };
  }
  return {
    file: join(opts.memoryDir, "hot", "cache.md"),
    mode: "global",
  };
}

if (import.meta.main) {
  const LOG_FILE = join(BUTLER_DIR.LOGS, "memory.log");

  const args = process.argv.slice(2);
  const project = getArg(args, "--project") ?? "unknown";
  const sessionId = getArg(args, "--session-id") ?? Date.now().toString();
  const projectPath = getArg(args, "--project-path");
  const topic = getArg(args, "--topic");
  // type param reserved for future use
  // const type = getArg(args, "--type") ?? "task";

  const resolved = resolveHotCachePath({
    topic,
    projectPath,
    memoryDir: BUTLER_DIR.MEMORY,
  });
  const CACHE_FILE = resolved.file;

  // Prepare target directory and optional .gitignore guard for project-local caches.
  if (resolved.mode === "project" && projectPath) {
    const butlerDir = join(projectPath, ".butler");
    mkdirSync(butlerDir, { recursive: true });
    const gitignore = join(butlerDir, ".gitignore");
    if (!existsSync(gitignore)) {
      writeFileSync(gitignore, "*\n", "utf8");
    }
  } else {
    // topic and global both live under BUTLER_DIR.MEMORY/hot/...
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
  }

  const text = await Bun.stdin.text();
  if (!text.trim()) process.exit(0);

  const now = new Date();
  const timeStr = now.toTimeString().slice(0, 5);

  // If already structured (starts with **), save as-is; otherwise summarize via the configured runtime
  let entryBody: string;
  if (text.trim().startsWith("**")) {
    entryBody = text.trim();
  } else {
    const prompt = `Analyze the following conversation and summarize it in the format below. Omit any sections that don't apply.

**Task**: Work performed, decisions made, completed/incomplete items (dev/file/search etc.)
**Learning**: New concepts learned, important insights
**Chat**: Core of casual conversation, exchange of opinions
**Preference**: User preferences/tastes/tendencies newly revealed in this conversation (exclude recurring ones)

Each section in 1-2 lines max. Omit the section entirely if empty.

Conversation:
${text.trim()}`;

    try {
      entryBody = await runPromptText({ prompt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`save_hot.ts: summarization failed — ${msg}`);
      appendFileSync(LOG_FILE, `[${now.toISOString()}] save_hot.ts: ERROR summarize — ${msg}\n`);
      process.exit(2);
    }
  }

  const header = topic
    ? `\n## [${timeStr}] ${project} | ${sessionId} | topic=${topic}\n`
    : `\n## [${timeStr}] ${project} | ${sessionId}\n`;
  const entry = `${header}${entryBody}\n`;
  appendFileSync(CACHE_FILE, entry);

  const topicLog = topic ? ` topic=${topic}` : "";
  const logEntry = `[${now.toISOString().slice(0, 19).replace("T", " ")}] save_hot.ts | project=${project} session=${sessionId}${topicLog} mode=${resolved.mode} | saved: ${entryBody.slice(0, 80)}\n`;
  appendFileSync(LOG_FILE, logEntry);

  // Auto-compact if cache exceeds 20KB soft threshold
  if (existsSync(CACHE_FILE) && statSync(CACHE_FILE).size > TWENTY_KB) {
    // Global mode delegates to compact.ts (handles LanceDB-aware compression).
    // Topic and project modes use inline compaction — simpler, self-contained,
    // and avoids compact.ts hardcoded global-cache path.
    if (resolved.mode === "global") {
      const compact = butlerAgentSourcePath(BUTLER_DIR.HOME, "agent", "cognition", "memory", "scripts", "compact.ts");
      if (existsSync(compact)) {
        spawnSync(process.execPath, ["run", compact], { encoding: "utf8", timeout: 120000 });
      }
    } else {
      const content = readFileSync(CACHE_FILE, "utf8");
      const rawEntries = content.split(/(?=\n## \[)/);
      const entries = rawEntries
        .map(e => e.replace(/^\n+/, ""))
        .filter(e => e.trim().length >= 20);
      if (entries.length >= 4) {
        const cutoff = Math.max(1, Math.floor(entries.length * 0.3));
        const newContent = entries.slice(cutoff).join("");
        writeFileSync(CACHE_FILE, newContent, "utf8");
      }
    }
  }
}
