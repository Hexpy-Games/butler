import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveWorkspacePathGuard } from "../shared/workspace-path-guard.ts";
import { fileToolEvidenceReceipt, sha256Hex } from "../shared/evidence.ts";
import { getWorkspaceRoot, tryParseToolArgs } from "../shared/args.ts";
import type { FileToolExecutionContext } from "../read_file/executor.ts";

function isNodeFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function inspectExistingTarget(filePath: string, path: string) {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return { ok: false as const, error: "target_not_regular_file", path };
    const before = await readFile(filePath);
    return { ok: true as const, existed: true, beforeSha256: sha256Hex(before) };
  } catch (error) {
    if (isNodeFsError(error) && error.code === "ENOENT") {
      return { ok: true as const, existed: false, beforeSha256: undefined };
    }
    return { ok: false as const, error: "target_stat_failed", path, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function ensureParentPolicy(filePath: string, createParents: boolean) {
  const parent = dirname(filePath);
  if (createParents) {
    await mkdir(parent, { recursive: true });
    return;
  }
  await access(parent, constants.W_OK);
}

export async function executeWriteFileTool(call: { arguments?: unknown; input?: unknown; args?: unknown }, context: FileToolExecutionContext = {}) {
  const parsed = tryParseToolArgs(call);
  if (!parsed.ok) return { ok: false, error: parsed.error, detail: parsed.detail };
  const a = parsed.args;
  const workspaceRoot = getWorkspaceRoot(a, context.workspacePath);
  const path = String(a.path ?? "");
  const content = String(a.content ?? "");
  const overwrite = Boolean(a.overwrite);
  const createParents = Boolean(a.create_parents);
  const expected = typeof a.expected_sha256 === "string" ? a.expected_sha256 : undefined;

  const guard = await resolveWorkspacePathGuard({ workspaceRoot, relativePath: path, allowMissingLeaf: true });
  if (!guard.ok) return { ok: false, error: guard.reason, path, guard };

  const existing = await inspectExistingTarget(guard.absolutePath!, path);
  if (!existing.ok) return existing;
  if (existing.existed && !overwrite) return { ok: false, error: "file_exists", path, before_sha256: existing.beforeSha256 };
  if (existing.existed && expected && existing.beforeSha256 !== expected) return { ok: false, error: "expected_sha256_mismatch", path, before_sha256: existing.beforeSha256, expected_sha256: expected };
  if (!existing.existed && expected) return { ok: false, error: "expected_sha256_on_missing_file", path, expected_sha256: expected };

  try {
    await ensureParentPolicy(guard.absolutePath!, createParents);
  } catch (error) {
    const code = isNodeFsError(error) ? error.code : undefined;
    return { ok: false, error: code === "ENOENT" ? "parent_directory_missing" : "parent_directory_unwritable", path, create_parents: createParents, detail: error instanceof Error ? error.message : String(error) };
  }

  const tmp = `${guard.absolutePath!}.butler-${process.pid}-${randomUUID()}.tmp`;
  const data = Buffer.from(content, "utf8");
  try {
    await writeFile(tmp, data, { flag: "wx" });
    await rename(tmp, guard.absolutePath!);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }

  const after = await readFile(guard.absolutePath!);
  const afterSha256 = sha256Hex(after);
  return { ok: true, path, created: !existing.existed, overwritten: existing.existed, bytes: after.length, before_sha256: existing.beforeSha256, after_sha256: afterSha256, atomic_write: true, create_parents: createParents, evidence_receipts: fileToolEvidenceReceipt({ toolName: "write_file", summary: `${existing.existed ? "Overwrote" : "Created"} workspace file ${path}`, references: { path, created: !existing.existed, overwritten: existing.existed, before_sha256: existing.beforeSha256, after_sha256: afterSha256, atomic_write: true, create_parents: createParents }, satisfies: ["durable_artifact"] }) };
}
