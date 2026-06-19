import { readFile, stat } from "node:fs/promises";
import { resolveWorkspacePathGuard } from "../shared/workspace-path-guard.ts";
import { fileToolEvidenceReceipt, sha256Hex } from "../shared/evidence.ts";
import { getWorkspaceRoot, tryParseToolArgs } from "../shared/args.ts";

export interface FileToolExecutionContext { workspacePath?: string; }

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

function truncateUtf8Safe(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let used = 0;
  let out = "";
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

export async function executeReadFileTool(call: { arguments?: unknown; input?: unknown; args?: unknown }, context: FileToolExecutionContext = {}) {
  const parsed = tryParseToolArgs(call);
  if (!parsed.ok) return { ok: false, error: parsed.error, detail: parsed.detail };
  const a = parsed.args;
  const workspaceRoot = getWorkspaceRoot(a, context.workspacePath);
  const path = String(a.path ?? "");
  const maxBytes = Math.max(1, Math.min(Number(a.max_bytes ?? 65536), 1048576));
  const startLineRaw = a.start_line === undefined ? undefined : Math.max(1, Number(a.start_line));
  const limitLinesRaw = a.limit_lines === undefined ? undefined : Math.max(1, Math.min(Number(a.limit_lines), 10000));
  const guard = await resolveWorkspacePathGuard({ workspaceRoot, relativePath: path });
  if (!guard.ok) return { ok: false, error: guard.reason, path, guard };
  const filePath = guard.realPath ?? guard.absolutePath!;
  const st = await stat(filePath);
  if (!st.isFile()) return { ok: false, error: "not_a_file", path };
  const data = await readFile(filePath);
  if (isBinary(data)) return { ok: false, error: "binary_file_not_supported", path, bytes: st.size };
  let text = data.toString("utf8");
  let startLine = 1;
  let endLine = text.split(/\r?\n/).length;
  let lineTruncated = false;
  if (startLineRaw !== undefined || limitLinesRaw !== undefined) {
    const lines = text.split(/\r?\n/);
    startLine = startLineRaw ?? 1;
    const zeroStart = Math.max(0, startLine - 1);
    const limit = limitLinesRaw ?? lines.length;
    const selected = lines.slice(zeroStart, zeroStart + limit);
    text = selected.join("\n");
    endLine = selected.length ? zeroStart + selected.length : zeroStart;
    lineTruncated = zeroStart + limit < lines.length;
  }
  const byteTruncated = Buffer.byteLength(text, "utf8") > maxBytes;
  if (byteTruncated) text = truncateUtf8Safe(text, maxBytes);
  const truncated = lineTruncated || byteTruncated;
  const sha256 = sha256Hex(data);
  return { ok: true, path, bytes: data.length, sha256, truncated, byte_truncated: byteTruncated, start_line: startLine, end_line: endLine, content: text, evidence_receipts: fileToolEvidenceReceipt({ toolName: "read_file", summary: `Read ${truncated ? "truncated " : ""}workspace file ${path}`, references: { path, bytes: data.length, sha256, truncated, byte_truncated: byteTruncated, start_line: startLine, end_line: endLine }, satisfies: ["source_verified"] }) };
}
