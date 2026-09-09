import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export type DashboardLedgerEvent = { id: string; recordId: string; kind: string; action: string; at: string };

/** Bounded metadata-only cache for a globally ordered history merge. The byte
 * reader remains the only log parser. No raw event body is retained. */
export function createProjectDashboardHistoryReader() {
  const cache = new Map<string, { revision: string; events: DashboardLedgerEvent[] }>();
  return (root: string) => {
    const path = join(root, "ledger.jsonl");
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return { revision: "absent", events: [] };
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error("dashboard_history_unavailable");
    const revision = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (cache.get(root)?.revision === revision) return cache.get(root)!;
    const events: DashboardLedgerEvent[] = [];
    let cursor: string | undefined;
    do {
      const page = readProjectDashboardHistory(root, cursor, 10000);
      events.push(...page.events); cursor = page.nextCursor ?? undefined;
      if (events.length > 100000) throw new Error("dashboard_history_unavailable");
    } while (cursor);
    const after = lstatSync(path);
    if (`${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== revision) throw new Error("dashboard_history_changed");
    const result = { revision, events };
    if (cache.size >= 4) cache.delete(cache.keys().next().value!);
    cache.set(root, result);
    return result;
  };
}

/** Bounded, reverse byte cursor. Old pages remain stable when the log grows. */
export function readProjectDashboardHistory(root: string, cursor: string | undefined, limit: number): {
  events: DashboardLedgerEvent[]; nextCursor: string | null;
} {
  const path = join(root, "ledger.jsonl");
  if (lstatSync(path).isSymbolicLink()) throw new Error("dashboard_history_invalid");
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    let end = stat.size;
    if (cursor) {
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (value.ino !== stat.ino || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > stat.size) {
        throw new Error("dashboard_history_cursor_invalid");
      }
      end = value.offset;
    }
    const start = Math.max(0, end - 262_144);
    const buffer = Buffer.alloc(end - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    if (read !== buffer.length) throw new Error("dashboard_history_changed");
    const first = start ? buffer.indexOf(10) + 1 : 0;
    if (start && (first === 0 || first === buffer.length)) throw new Error("dashboard_history_record_too_large");
    const events: DashboardLedgerEvent[] = [];
    let offset = buffer.length;
    while (offset > first && events.length < limit) {
      const lineEnd = buffer[offset - 1] === 10 ? offset - 1 : offset;
      if (lineEnd <= 0) { offset = 0; break; }
      const newline = buffer.lastIndexOf(10, lineEnd - 1);
      const lineStart = Math.max(first, newline + 1);
      const raw = buffer.subarray(lineStart, lineEnd).toString("utf8");
      offset = lineStart;
      try {
        const event = JSON.parse(raw);
        const type = String(event.type ?? "").match(/^(work|task|plan|spec|report)_(created|updated|completed)$/u);
        if (!type || typeof event.id !== "string" || typeof event.ts !== "string" || !Number.isFinite(Date.parse(event.ts))) continue;
        events.push({ id: `${stat.ino}:${start + lineStart}`, recordId: event.id, kind: type[1]!, action: type[2]!, at: event.ts });
      } catch { /* A damaged/incomplete line is not a public event. */ }
    }
    const next = start + offset;
    return { events, nextCursor: next > 0 ? Buffer.from(JSON.stringify({ ino: stat.ino, offset: next })).toString("base64url") : null };
  } finally { closeSync(fd); }
}
