import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveWorkspacePathGuard, looksSensitiveWorkspacePath } from "../shared/workspace-path-guard.ts";
import { fileToolEvidenceReceipt } from "../shared/evidence.ts";
import { getWorkspaceRoot, parseToolArgs, stringArray } from "../shared/args.ts";
import type { FileToolExecutionContext } from "../read_file/executor.ts";

function globToRe(glob: string) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") { out += ".*"; i += 1; continue; }
    if (ch === "*") { out += "[^/]*"; continue; }
    out += ch.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function isBinary(b: Buffer) { const n = Math.min(b.length, 2048); for (let i = 0; i < n; i += 1) if (b[i] === 0) return true; return false; }
async function walk(root: string, dir: string, out: string[]) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    const rel = relative(root, abs).replace(/\\/g, "/");
    if (looksSensitiveWorkspacePath(rel)) continue;
    if (ent.isDirectory()) { if (ent.name === ".git" || ent.name === "node_modules") continue; await walk(root, abs, out); }
    else if (ent.isFile()) out.push(rel);
  }
}
export async function executeGrepFilesTool(call: { arguments?: unknown; input?: unknown; args?: unknown }, context: FileToolExecutionContext = {}) {
  const a = parseToolArgs(call);
  const workspaceRoot = getWorkspaceRoot(a, context.workspacePath);
  const pattern = String(a.pattern ?? a.query ?? "");
  const regex = Boolean(a.regex ?? false);
  const caseSensitive = Boolean(a.case_sensitive ?? true);
  const include = stringArray(a.include ?? a.include_globs);
  const exclude = stringArray(a.exclude ?? a.exclude_globs);
  const contextLines = Math.max(0, Math.min(Number(a.context ?? a.context_lines ?? 0), 10));
  const maxMatches = Math.max(1, Math.min(Number(a.max_matches ?? 100), 1000));
  const maxBytes = Math.max(1, Math.min(Number(a.max_bytes_per_file ?? 262144), 1048576));
  if (!pattern) return { ok: false, error: "missing_pattern" };
  const guard = await resolveWorkspacePathGuard({ workspaceRoot, relativePath: ".", allowDirectories: true });
  if (!guard.ok) return { ok: false, error: guard.reason, guard };
  let matcher: RegExp;
  try { matcher = new RegExp(regex ? pattern : escapeRegExp(pattern), caseSensitive ? "" : "i"); } catch (error) { return { ok: false, error: "invalid_pattern", detail: error instanceof Error ? error.message : String(error) }; }
  const inc = include.length ? include.map(globToRe) : [/.*/];
  const exc = exclude.map(globToRe);
  const files: string[] = [];
  await walk(guard.realPath!, guard.realPath!, files);
  const matches: Array<{ path: string; line: number; text: string; context: Array<{ line: number; text: string }> }> = [];
  let filesSearched = 0; let filesSkipped = 0; let truncated = false;
  for (const f of files) {
    if (!inc.some((r) => r.test(f)) || exc.some((r) => r.test(f))) continue;
    const abs = join(guard.realPath!, f);
    const st = await stat(abs);
    if (st.size > maxBytes) { filesSkipped += 1; truncated = true; continue; }
    const buf = await readFile(abs);
    if (isBinary(buf)) { filesSkipped += 1; continue; }
    filesSearched += 1;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      matcher.lastIndex = 0;
      if (matcher.test(lines[i])) {
        const start = Math.max(0, i - contextLines); const end = Math.min(lines.length - 1, i + contextLines);
        matches.push({ path: f, line: i + 1, text: lines[i], context: lines.slice(start, end + 1).map((text, idx) => ({ line: start + idx + 1, text })) });
        if (matches.length >= maxMatches) { truncated = true; return { ok: true, pattern, regex, case_sensitive: caseSensitive, files_searched: filesSearched, files_skipped: filesSkipped, matches, truncated, evidence_receipts: fileToolEvidenceReceipt({ toolName: "grep_files", summary: `Found ${matches.length} matches for ${pattern}`, references: { pattern, regex, case_sensitive: caseSensitive, files_searched: filesSearched, files_skipped: filesSkipped, truncated }, satisfies: ["source_verified"] }) }; }
      }
    }
  }
  return { ok: true, pattern, regex, case_sensitive: caseSensitive, files_searched: filesSearched, files_skipped: filesSkipped, matches, truncated, evidence_receipts: fileToolEvidenceReceipt({ toolName: "grep_files", summary: `Found ${matches.length} matches for ${pattern}`, references: { pattern, regex, case_sensitive: caseSensitive, files_searched: filesSearched, files_skipped: filesSkipped, truncated }, satisfies: ["source_verified"] }) };
}
