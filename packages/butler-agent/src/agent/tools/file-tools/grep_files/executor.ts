import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { resolveWorkspacePathGuard, looksSensitiveWorkspacePath } from "../shared/workspace-path-guard.ts";
import { fileToolCapabilityReceipt, fileToolEvidenceReceipt } from "../shared/evidence.ts";
import { getWorkspaceRoot, stringArray, tryParseToolArgs } from "../shared/args.ts";
import type { FileToolExecutionContext } from "../read_file/executor.ts";

const DEFAULT_EXCLUDED_DIRS = new Set([".git", ".project-ledger", "project-ledger", "node_modules", "dist", "build", ".next", "coverage", ".turbo", "vendor"]);

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function isBinary(b: Buffer) { const n = Math.min(b.length, 2048); for (let i = 0; i < n; i += 1) if (b[i] === 0) return true; return false; }

interface WalkState { files: string[]; dirsVisited: number; truncated: boolean; stoppedBy?: string; startedAt: number; }
interface WalkLimits { maxFiles: number; maxDirs: number; maxDepth: number; timeoutMs: number; }

async function walk(root: string, dir: string, depth: number, out: WalkState, limits: WalkLimits) {
  if (out.truncated) return;
  if (Date.now() - out.startedAt > limits.timeoutMs) { out.truncated = true; out.stoppedBy = "timeout"; return; }
  if (depth > limits.maxDepth) { out.truncated = true; out.stoppedBy = "max_depth"; return; }
  out.dirsVisited += 1;
  if (out.dirsVisited > limits.maxDirs) { out.truncated = true; out.stoppedBy = "max_dirs"; return; }
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (out.truncated) return;
    const abs = join(dir, ent.name);
    const rel = relative(root, abs).replace(/\\/g, "/");
    if (looksSensitiveWorkspacePath(rel)) continue;
    if (ent.isDirectory()) {
      if (DEFAULT_EXCLUDED_DIRS.has(ent.name)) continue;
      await walk(root, abs, depth + 1, out, limits);
    } else if (ent.isFile()) {
      out.files.push(rel);
      if (out.files.length >= limits.maxFiles) { out.truncated = true; out.stoppedBy = "max_files"; return; }
    }
  }
}

export async function executeGrepFilesTool(call: { arguments?: unknown; input?: unknown; args?: unknown }, context: FileToolExecutionContext = {}) {
  const parsed = tryParseToolArgs(call);
  if (!parsed.ok) return { ok: false, error: parsed.error, detail: parsed.detail, evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: false, error: parsed.error }) };
  const a = parsed.args;
  const workspaceRoot = getWorkspaceRoot(a, context.workspacePath);
  const pattern = String(a.pattern ?? "").trim();
  const regex = Boolean(a.regex ?? false);
  const caseSensitive = Boolean(a.case_sensitive ?? true);
  const include = stringArray(a.include ?? a.include_globs);
  const exclude = stringArray(a.exclude ?? a.exclude_globs);
  const contextLines = Math.max(0, Math.min(Number(a.context ?? a.context_lines ?? 0), 10));
  const maxMatches = Math.max(1, Math.min(Number(a.max_matches ?? 100), 1000));
  const maxBytes = Math.max(1, Math.min(Number(a.max_bytes_per_file ?? 262144), 1048576));
  const limits: WalkLimits = {
    maxFiles: Math.max(1, Math.min(Number(a.max_files ?? 5000), 50000)),
    maxDirs: Math.max(1, Math.min(Number(a.max_dirs ?? 1000), 10000)),
    maxDepth: Math.max(1, Math.min(Number(a.max_depth ?? 25), 100)),
    timeoutMs: Math.max(50, Math.min(Number(a.timeout_ms ?? 5000), 30000)),
  };
  if (!pattern) return { ok: false, error: "missing_pattern", evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: false, error: "missing_pattern" }) };
  const guard = await resolveWorkspacePathGuard({
    workspaceRoot,
    relativePath: ".",
    allowDirectories: true,
    rejectProtectedProjectLedgerPaths: true,
    protectedProjectLedgerRoots: context.protectedProjectLedgerRoots,
  });
  if (!guard.ok) return { ok: false, error: guard.reason, guard, evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: false, error: guard.reason }) };
  let matcher: RegExp;
  try { matcher = new RegExp(regex ? pattern : escapeRegExp(pattern), caseSensitive ? "" : "i"); } catch (error) { return { ok: false, error: "invalid_pattern", detail: error instanceof Error ? error.message : String(error), evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: false, error: "invalid_pattern" }) }; }
  const inc = include.length ? include.map(workspaceGlobMatcher) : [() => true];
  const exc = exclude.map(workspaceGlobMatcher);
  const walkState: WalkState = { files: [], dirsVisited: 0, truncated: false, startedAt: Date.now() };
  await walk(guard.realPath!, guard.realPath!, 0, walkState, limits);
  const matches: Array<{ path: string; line: number; text: string; context: Array<{ line: number; text: string }> }> = [];
  let filesSearched = 0; let filesSkipped = 0; let truncated = walkState.truncated; let stoppedBy = walkState.stoppedBy;
  for (const f of walkState.files) {
    if (!inc.some((matches) => matches(f)) || exc.some((matches) => matches(f))) continue;
    const abs = join(guard.realPath!, f);
    const st = await stat(abs);
    if (st.size > maxBytes) { filesSkipped += 1; truncated = true; stoppedBy = stoppedBy ?? "max_bytes_per_file"; continue; }
    const buf = await readFile(abs);
    if (isBinary(buf)) { filesSkipped += 1; continue; }
    filesSearched += 1;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      matcher.lastIndex = 0;
      if (matcher.test(lines[i])) {
        const start = Math.max(0, i - contextLines); const end = Math.min(lines.length - 1, i + contextLines);
        matches.push({ path: f, line: i + 1, text: lines[i], context: lines.slice(start, end + 1).map((text, idx) => ({ line: start + idx + 1, text })) });
        if (matches.length >= maxMatches) { truncated = true; stoppedBy = stoppedBy ?? "max_matches"; return { ok: true, pattern, regex, case_sensitive: caseSensitive, files_searched: filesSearched, files_skipped: filesSkipped, dirs_visited: walkState.dirsVisited, files_considered: walkState.files.length, matches, truncated, stopped_by: stoppedBy, evidence_receipts: fileToolEvidenceReceipt({ toolName: "grep_files", summary: `Found ${matches.length} matches for ${pattern}`, references: { pattern, regex, case_sensitive: caseSensitive, files_searched: filesSearched, files_skipped: filesSkipped, dirs_visited: walkState.dirsVisited, files_considered: walkState.files.length, truncated, stopped_by: stoppedBy }, satisfies: [] }), evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: true, truncated, filesSearched, filesSkipped, matches }) }; }
      }
    }
  }
  return { ok: true, pattern, regex, case_sensitive: caseSensitive, files_searched: filesSearched, files_skipped: filesSkipped, dirs_visited: walkState.dirsVisited, files_considered: walkState.files.length, matches, truncated, stopped_by: stoppedBy, evidence_receipts: fileToolEvidenceReceipt({ toolName: "grep_files", summary: `Found ${matches.length} matches for ${pattern}`, references: { pattern, regex, case_sensitive: caseSensitive, files_searched: filesSearched, files_skipped: filesSkipped, dirs_visited: walkState.dirsVisited, files_considered: walkState.files.length, truncated, stopped_by: stoppedBy }, satisfies: [] }), evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: true, truncated, filesSearched, filesSkipped, matches }) };
}

function workspaceGlobMatcher(glob: string): (path: string) => boolean {
  const matcher = new Bun.Glob(glob);
  const matchesBasename = !glob.includes("/");
  return (path) => matcher.match(path) || (matchesBasename && matcher.match(basename(path)));
}
