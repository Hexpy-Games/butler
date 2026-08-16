// Shared session discovery + offset helpers.
import { createRequire } from "node:module";
import { join } from "path";
import { homedir } from "os";
import { SessionBindingStore } from "../../../../../test-support/harness/session-store.ts";
import type { StoredSessionBinding } from "../../../../../test-support/harness/contracts.ts";
import { transcriptFileNameForSessionId } from "./session-id.ts";

const fs: typeof import("fs") = createRequire(import.meta.url)("fs");

export interface SessionOffset {
  sessionId: string;
  lastLine: number;
  /**
   * Byte position in the transcript file. Phase 3 extension — legacy payloads
   * without this field are treated as 0 and re-scanned on first catchup.
   */
  byteOffset: number;
}

export type OffsetMap = Record<string, SessionOffset>;

export function loadOffsets(path: string): OffsetMap {
  if (!fs.existsSync(path)) return {};
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  // Migrate legacy single-offset shape {sessionId,lastLine} → {butler: {...}}
  if (typeof raw?.sessionId === "string" && typeof raw?.lastLine === "number") {
    raw = { butler: { sessionId: raw.sessionId, lastLine: raw.lastLine } };
  }
  const out: OffsetMap = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const o: any = v;
    if (typeof o?.sessionId !== "string" || typeof o?.lastLine !== "number") continue;
    out[k] = {
      sessionId: o.sessionId,
      lastLine: o.lastLine,
      byteOffset: typeof o.byteOffset === "number" ? o.byteOffset : 0,
    };
  }
  return out;
}

export function saveOffsets(map: OffsetMap, path: string): void {
  fs.mkdirSync(join(path, ".."), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(map, null, 2));
}

export function backfillByteOffset(transcriptPath: string): number {
  if (!fs.existsSync(transcriptPath)) return 0;
  return fs.statSync(transcriptPath).size;
}

// ---------------------------------------------------------------------------
// Session discovery — mirrors session-sync.ts helpers without their cron
// side-effects. Accepts dependencies so tests can inject tmp fixtures.
// ---------------------------------------------------------------------------

export interface SessionDiscoveryDeps {
  butlerHome?: string;
  butlerData?: string;
  sessionHistoryFile?: string;
  sessionIdFile?: string;
}

export interface DiscoveredSession {
  path: string;
  sessionId: string;
}

export interface LocalSessionDiscoveryDeps {
  butlerData?: string;
  storePath?: string;
}

export interface LocalLiveSessionSource {
  session: StoredSessionBinding;
  path: string;
  projectName: string;
  source: "butler" | "steward";
  topic?: string;
}

export function findMainSessions(deps: SessionDiscoveryDeps = {}): DiscoveredSession[] {
  const data = deps.butlerData ?? process.env.BUTLER_DATA ?? join(homedir(), ".butler");
  const historyFile =
    deps.sessionHistoryFile ?? join(data, "config", "session-history.txt");
  const idFile = deps.sessionIdFile ?? join(data, "config", "session-id.txt");
  const transcriptDir = join(data, "transcripts");

  let ids: string[] = [];
  if (fs.existsSync(historyFile)) {
    ids = [
      ...new Set(
        fs
          .readFileSync(historyFile, "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      ),
    ];
  } else if (fs.existsSync(idFile)) {
    const id = fs.readFileSync(idFile, "utf8").trim();
    if (id) ids = [id];
  }

  if (ids.length === 0) return [];

  const results: Array<DiscoveredSession & { mtime: number }> = [];
  for (const id of ids) {
    const full = join(transcriptDir, transcriptFileNameForSessionId(id));
    if (fs.existsSync(full)) {
      results.push({ path: full, sessionId: id, mtime: fs.statSync(full).mtimeMs });
    }
  }
  results.sort((a, b) => a.mtime - b.mtime);
  return results.map(({ path, sessionId }) => ({ path, sessionId }));
}

export function findLocalLiveSessions(deps: LocalSessionDiscoveryDeps = {}): LocalLiveSessionSource[] {
  const butlerData = deps.butlerData ?? process.env.BUTLER_DATA ?? join(homedir(), ".butler");
  const store = new SessionBindingStore(
    deps.storePath ?? join(butlerData, "runtime", "session-store.sqlite"),
  );

  try {
    const sources: LocalLiveSessionSource[] = [];
    for (const session of store
      .listSessions({ lifecycleState: ["active", "closing"] })
    ) {
      const path = join(butlerData, "transcripts", transcriptFileNameForSessionId(session.sessionId));
      if (!fs.existsSync(path)) continue;
      const threadBinding = session.transportBindings.find((binding) => binding.threadId);
      sources.push({
        session,
        path,
        projectName: session.projectId ?? (session.role === "butler" ? "butler" : session.sessionId),
        source: session.role === "butler" ? "butler" : "steward",
        topic: threadBinding?.threadId,
      });
    }
    return sources.sort((left, right) => left.session.updatedAt.localeCompare(right.session.updatedAt));
  } finally {
    store.close();
  }
}
