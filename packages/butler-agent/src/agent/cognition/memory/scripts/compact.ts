// Compacts cache.md when it exceeds 20KB (soft threshold).
// Hard cap: if cache exceeds 40KB after compaction, oldest entries are dropped.
// Already-compressed entries ([compressed] blocks) bypass the LanceDB check.
import { existsSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { BUTLER_DIR, TWENTY_KB, FORTY_KB } from "./constants.ts";
import { runPromptText } from "../../../../integrations/providers/provider.ts";
import { butlerAgentSourcePath } from "../../../../runtime/paths.ts";

// ---------------------------------------------------------------------------
// Pure exported functions — importable by tests without filesystem side effects
// ---------------------------------------------------------------------------

/**
 * Returns true if the entry should BYPASS the LanceDB session-id existence check.
 * [compressed] blocks: already summaries, no live session-id to verify.
 * Malformed headers (neither session-id nor [compressed]): logged separately, skipped.
 */
export function shouldBypassLanceDBCheck(entry: string): boolean {
  // A valid session entry looks like:  ## [HH:MM] project | <session-id>
  const hasSessionId = /## \[[\d:]+\] \S+ \| (\S+)/.test(entry);
  if (hasSessionId) return false; // has a real session-id → do not bypass

  // Explicitly check for [compressed] tag
  const isCompressed = /## \[compressed\]/.test(entry);
  if (isCompressed) {
    // [compressed] block — already a summary, bypass check
    return true;
  }

  // Malformed header: matches neither session-id nor [compressed] tag
  // Treat as bypass (no session-id to check) — logged separately in callers
  return true;
}

/**
 * Extracts the date from a [compressed] block header.
 * Returns { blockDate: string } if this is a [compressed] entry, null otherwise.
 * Option B: single date, matching what compact.ts already stores.
 */
export function extractCompressedDateRange(entry: string): { blockDate: string } | null {
  const m = entry.match(/## \[compressed\] (\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  return { blockDate: m[1] };
}

/**
 * Applies the hard cap: drops oldest entries until totalSize <= hardCap.
 * Returns the surviving entries.
 * For [compressed] entries, checks LanceDB count before dropping.
 * If LanceDB count is 0 → skip (don't drop) to avoid data loss.
 * Regular entries are always dropped without a count check.
 */
export function applyHardCap(entries: string[], hardCap: number): string[] {
  let totalSize = entries.reduce((sum, e) => sum + Buffer.byteLength(e, "utf8"), 0);
  if (totalSize <= hardCap) return [...entries];

  const kept = [...entries];
  let i = 0;
  while (totalSize > hardCap && i < kept.length) {
    const candidate = kept[i];
    const isCompressed = /## \[compressed\]/.test(candidate);

    if (isCompressed) {
      // Sanity check: count LanceDB records for this block's date
      const dateInfo = extractCompressedDateRange(candidate);
      const blockDate = dateInfo?.blockDate ?? "unknown";
      const lanceDBCount = queryLanceDBCount(blockDate);

      if (lanceDBCount === 0) {
        // 0 records confirmed → data unrecoverable if dropped, skip this entry
        console.log(`compact.ts: WARNING — skipping eviction of [compressed] block ${blockDate} — 0 LanceDB records (data may be unrecoverable)`);
        i++;
        continue;
      }

      console.log(`compact.ts: evicting [compressed] ${blockDate}`);
    } else {
      const sessionMatch = candidate.match(/## \[[\d:]+\] \S+ \| (\S+)/);
      const meta = sessionMatch?.[1] ?? candidate.slice(0, 60).split("\n")[0];
      console.log(`compact.ts: evicting entry: ${meta}`);
    }

    kept.splice(i, 1);
    totalSize -= Buffer.byteLength(candidate, "utf8");
    // Don't increment i — next entry slides into position i
  }

  return kept;
}

/**
 * Returns true if content size is at or below the soft cap threshold.
 * Used to decide whether compaction should be skipped.
 */
export function isUnderThreshold(content: string, softCap: number): boolean {
  return Buffer.byteLength(content, "utf8") <= softCap;
}

// ---------------------------------------------------------------------------
// Internal: Query LanceDB record count for a given date.
// Returns 0 (fail-safe: skip drop) if LanceDB is unavailable or query fails.
// Returning 0 causes the sanity check to say "no records confirmed, don't drop."
// Exported for testing only — allows tests to spy/mock this function.
// ---------------------------------------------------------------------------
export function queryLanceDBCount(date: string): number {
  const countScript = butlerAgentSourcePath(BUTLER_DIR.HOME, "agent", "cognition", "memory", "scripts", "index.ts");
  if (!existsSync(countScript)) return 0;

  try {
    const result = spawnSync(process.execPath, [
      "run", countScript,
      "--count-by-date", date,
    ], { encoding: "utf8", timeout: 10000 });

    if (result.status !== 0) return 0;

    const n = parseInt(result.stdout?.trim() ?? "", 10);
    return isNaN(n) ? 0 : n;
  } catch {
    // spawnSync threw (e.g. ENOENT, timeout, or test injection) → fail-safe
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Script entry point — only runs when invoked directly (not when imported)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const CACHE_FILE = join(BUTLER_DIR.MEMORY, "hot", "cache.md");

  if (!existsSync(CACHE_FILE)) process.exit(0);
  if (statSync(CACHE_FILE).size <= TWENTY_KB) process.exit(0);

  const content = readFileSync(CACHE_FILE, "utf8");

  // Split into entries: each starts with "\n## [" or "## ["
  const rawEntries = content.split(/(?=\n## \[)/);
  const entries = rawEntries
    .map(e => e.replace(/^\n+/, ""))
    .filter(e => e.trim().length >= 20);

  if (entries.length < 4) {
    // Too few entries to compress meaningfully
    process.exit(0);
  }

  // Take oldest 30% (first entries)
  const cutoff = Math.max(1, Math.floor(entries.length * 0.3));
  const oldEntries = entries.slice(0, cutoff);
  const newEntries = entries.slice(cutoff);

  // Extract date for the compressed block header
  const today = new Date().toISOString().slice(0, 10);

  // Check if sessions in old entries are indexed in LanceDB before compressing.
  // [compressed] entries bypass this check — they are already summaries with no live session-id.
  // Malformed headers (no session-id, no [compressed] tag) also bypass with a log.
  const indexScript = butlerAgentSourcePath(BUTLER_DIR.HOME, "agent", "cognition", "memory", "scripts", "index.ts");
  let sessionCheckPassed = true;

  if (existsSync(indexScript)) {
    for (const entry of oldEntries) {
      if (shouldBypassLanceDBCheck(entry)) {
        // [compressed] block or malformed header — no session-id to verify, skip
        const isCompressed = /## \[compressed\]/.test(entry);
        if (!isCompressed) {
          console.log("compact.ts: malformed header in old entry, bypassing LanceDB check");
        }
        continue;
      }

      const m = entry.match(/## \[[\d:]+\] \S+ \| (\S+)/);
      const checkResult = spawnSync(process.execPath, [
        "run", indexScript,
        "--check-session", m![1],
      ], { encoding: "utf8", timeout: 10000 });
      // If check returns non-zero, session not indexed — skip compaction
      if (checkResult.status !== 0 && checkResult.stderr?.includes("not indexed")) {
        sessionCheckPassed = false;
        break;
      }
    }
  }

  if (!sessionCheckPassed) {
    console.log("compact.ts: some sessions not yet indexed in LanceDB, skipping compaction");
    // Still enforce hard cap even when normal compaction is blocked
    const cappedEntries = applyHardCap(entries, FORTY_KB);
    if (cappedEntries.length < entries.length) {
      writeFileSync(CACHE_FILE, cappedEntries.join("\n") + "\n", "utf8");
    }
    process.exit(0);
  }

  const oldEntriesText = oldEntries.join("");

  const prompt = `Compress the following conversation logs into a single concise summary.
Preserve only important decisions, project status changes, and key insights.
Within 3-7 lines.

${oldEntriesText}`;

  try {
    const compressedBody = await runPromptText({ prompt });
    const compressedBlock = `## [compressed] ${today}\n${compressedBody}\n`;

    const allEntries = [compressedBlock, ...newEntries.map(e => e.replace(/^\n+/, ""))];
    const newContent = allEntries.join("\n") + "\n";
    writeFileSync(CACHE_FILE, newContent, "utf8");

    console.log(`compact.ts: compressed ${cutoff} entries into summary block`);

    // Enforce hard cap after compaction
    const cappedAfter = applyHardCap(allEntries, FORTY_KB);
    if (cappedAfter.length < allEntries.length) {
      writeFileSync(CACHE_FILE, cappedAfter.join("\n") + "\n", "utf8");
      console.log(`compact.ts: hard cap applied — dropped ${allEntries.length - cappedAfter.length} entries`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`compact.ts: compression failed — ${msg}`);
    process.exit(2);
  }
}
