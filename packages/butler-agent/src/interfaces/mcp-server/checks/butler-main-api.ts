/**
 * butler-main-api.ts — Watchdog check for butler-main API errors.
 *
 * Local-first behavior:
 *   - resolve the active butler durable session from the session store
 *   - read butler-owned transcript JSONL for that session
 *   - count generic api_error and status_code 429/5xx markers in the last 5 min
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { SessionBindingStore } from "../../../test-support/harness/session-store.ts";
import { transcriptPath } from "../../../test-support/harness/transcripts.ts";
import { butlerAgentScriptPath } from "../../../runtime/paths.ts";

const WINDOW_MS = 5 * 60 * 1000;
const TAIL_LINES = 200;

export interface ApiErrorCounts {
  apiErrors: number;
  rl429: number;
  srv5xx: number;
}

export interface ButlerMainApiCheckDeps {
  butlerData?: string;
  sessionIdFile?: string;
  sessionStorePath?: string;
  source?: "local";
  now?: number;
  notify?: (key: string, ttl: number, message: string) => Promise<void>;
}

function getButlerHome(): string {
  return process.env.BUTLER_HOME || process.cwd();
}

function getButlerData(): string {
  return process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function sessionIdFilePath(butlerData: string): string {
  return join(butlerData, "config", "session-id.txt");
}

function notifyGuardPath(): string {
  return butlerAgentScriptPath(getButlerHome(), "lib", "notify-guard.sh");
}

async function notifyOnce(key: string, ttl: number, message: string): Promise<void> {
  const guard = notifyGuardPath();
  if (!existsSync(guard)) return;
  try {
    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        `source "${guard}" && notify_once "$1" "$2" "$3"`,
        "notify_once",
        key,
        String(ttl),
        message,
      ],
      {
        env: { ...process.env, BUTLER_HOME: getButlerHome(), BUTLER_DATA: getButlerData() },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    await proc.exited;
  } catch {}
}

function tailLines(path: string, maxLines = TAIL_LINES): string[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  return lines.slice(-maxLines);
}

export function resolveActiveButlerSessionId(deps: ButlerMainApiCheckDeps = {}): string | null {
  const butlerData = deps.butlerData ?? getButlerData();
  const storePath = deps.sessionStorePath ?? join(butlerData, "runtime", "session-store.sqlite");

  if (existsSync(storePath)) {
    const store = new SessionBindingStore(storePath);
    try {
      const activeButler = store
        .listSessions({ lifecycleState: ["active", "closing"] })
        .find((session) => session.role === "butler");
      if (activeButler?.sessionId) return activeButler.sessionId;
    } finally {
      store.close();
    }
  }

  const sessionIdFile = deps.sessionIdFile ?? sessionIdFilePath(butlerData);
  if (!existsSync(sessionIdFile)) return null;
  const sessionId = readFileSync(sessionIdFile, "utf8").trim();
  return sessionId || null;
}

export function readLocalButlerMainLines(deps: ButlerMainApiCheckDeps = {}): string[] {
  const sessionId = resolveActiveButlerSessionId(deps);
  if (!sessionId) return [];
  return tailLines(transcriptPath(sessionId), TAIL_LINES);
}

function parseTimestamp(line: string): number | null {
  try {
    const obj = JSON.parse(line);
    const ts = obj.timestamp ?? obj.ts;
    if (typeof ts === "string") {
      const t = Date.parse(ts);
      return Number.isNaN(t) ? null : t;
    }
    if (typeof ts === "number") return ts;
  } catch {}
  return null;
}

export function parseTimestampExported(line: string): number | null {
  return parseTimestamp(line);
}

export function detectApiErrors(lines: string[], now: number): ApiErrorCounts {
  let apiErrors = 0;
  let rl429 = 0;
  let srv5xx = 0;

  for (const line of lines) {
    const ts = parseTimestamp(line);
    if (ts !== null && now - ts > WINDOW_MS) continue;

    if (line.includes("api_error")) apiErrors += 1;
    if (/status_code"?\s*:\s*429/.test(line) || /statusCode"?\s*:\s*429/.test(line)) rl429 += 1;
    if (/status_code"?\s*:\s*5\d\d/.test(line) || /statusCode"?\s*:\s*5\d\d/.test(line)) srv5xx += 1;
  }

  return { apiErrors, rl429, srv5xx };
}

export async function checkButlerMainApi(deps: ButlerMainApiCheckDeps = {}): Promise<void> {
  const lines = readLocalButlerMainLines(deps);
  if (lines.length === 0) return;

  const now = deps.now ?? Date.now();
  const { apiErrors, rl429, srv5xx } = detectApiErrors(lines, now);
  const notify = deps.notify ?? notifyOnce;

  if (rl429 > 0) {
    await notify("butler-main-429", 600, `⚠️ butler-main: ${rl429} rate-limit (429) hits in last 5min`);
  }
  if (srv5xx > 0) {
    await notify("butler-main-5xx", 600, `⚠️ butler-main: ${srv5xx} server-error (5xx) hits in last 5min`);
  }
  if (apiErrors > 0 && rl429 === 0 && srv5xx === 0) {
    await notify("butler-main-api_error", 600, `⚠️ butler-main: ${apiErrors} api_error events in last 5min`);
  }
}
