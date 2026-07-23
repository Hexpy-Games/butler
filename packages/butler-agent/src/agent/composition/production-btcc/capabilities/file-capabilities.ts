import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { resolveWorkspacePathGuard } from "../../../tools/file-tools/shared/workspace-path-guard.ts";
import { OperationRejectedError } from "../../../btcc/index.ts";
import type { CapabilityExecutionContext } from "./contracts.ts";
import { pathMatchesFilters } from "./path-glob-filter.ts";

type FileCapabilityName = "list_files" | "read_file" | "write_file" | "grep_files";

export async function executeFileCapability(
  capability: FileCapabilityName,
  args: Record<string, unknown>,
  context: CapabilityExecutionContext,
): Promise<unknown> {
  if (capability === "list_files") return listWorkspaceFiles(args, context);
  if (capability === "read_file") return readWorkspaceFile(args, context);
  if (capability === "write_file") return writeWorkspaceFile(args, context);
  return searchWorkspaceFiles(args, context);
}

async function listWorkspaceFiles(
  args: Record<string, unknown>,
  context: CapabilityExecutionContext,
) {
  const maxFiles = number(args.max_files, 500);
  const matching = (await collectFiles(context.workspacePath))
    .map((path) => relative(context.workspacePath, path))
    .filter((path) => selected(path, args));
  return {
    files: matching.slice(0, maxFiles),
    truncated: matching.length > maxFiles,
  };
}

async function readWorkspaceFile(
  args: Record<string, unknown>,
  context: CapabilityExecutionContext,
) {
  const target = await requireWorkspacePath(context.workspacePath, text(args.path));
  const bytes = await readFile(target);
  const maxBytes = number(args.max_bytes, 1_048_576);
  if (bytes.byteLength > maxBytes) throw new Error(`read_file exceeds max_bytes: ${bytes.byteLength}`);
  if (bytes.includes(0)) throw new Error("read_file accepts UTF-8 text only");
  const lines = bytes.toString("utf8").split("\n");
  const start = number(args.start_line, 1);
  const limit = number(args.limit_lines, 2_000);
  return {
    path: relative(context.workspacePath, target),
    startLine: start,
    endLine: Math.min(lines.length, start + limit - 1),
    totalLines: lines.length,
    content: lines.slice(start - 1, start - 1 + limit).join("\n"),
  };
}

async function writeWorkspaceFile(
  args: Record<string, unknown>,
  context: CapabilityExecutionContext,
) {
  const requestedPath = text(args.path);
  const target = await requireWorkspacePath(context.workspacePath, requestedPath, true);
  const current = await readFile(target).catch(() => undefined);
  if (current && args.overwrite !== true) throw new Error("write_file requires overwrite=true");
  if (typeof args.expected_sha256 === "string") {
    const actual = current ? sha256(current) : "missing";
    if (actual !== args.expected_sha256) throw new Error("write_file expected_sha256 does not match");
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.btcc-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, text(args.content), "utf8");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  const written = await readFile(target);
  return {
    path: requestedPath,
    bytes: written.byteLength,
    sha256: sha256(written),
    created: current === undefined,
  };
}

async function searchWorkspaceFiles(
  args: Record<string, unknown>,
  context: CapabilityExecutionContext,
) {
  const pattern = text(args.pattern);
  const matcher = args.regex === true
    ? new RegExp(pattern, args.case_sensitive === true ? "g" : "gi")
    : undefined;
  const needle = args.case_sensitive === true ? pattern : pattern.toLowerCase();
  const maxMatches = number(args.max_matches, 200);
  const files = await collectFiles(context.workspacePath);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const path of files) {
    if (!selected(relative(context.workspacePath, path), args)) continue;
    const body = await readFile(path).catch(() => undefined);
    if (!body || body.byteLength > 1_048_576 || body.includes(0)) continue;
    const lines = body.toString("utf8").split("\n");
    for (let index = 0; index < lines.length && matches.length < maxMatches; index += 1) {
      const haystack = args.case_sensitive === true ? lines[index] : lines[index].toLowerCase();
      if (matcher ? (matcher.lastIndex = 0, matcher.test(lines[index])) : haystack.includes(needle)) {
        matches.push({ path: relative(context.workspacePath, path), line: index + 1, text: lines[index] });
      }
    }
    if (matches.length >= maxMatches) break;
  }
  return { pattern, matches, truncated: matches.length >= maxMatches };
}

async function requireWorkspacePath(root: string, path: string, allowMissingLeaf = false) {
  const guarded = await resolveWorkspacePathGuard({
    workspaceRoot: root,
    relativePath: path,
    allowMissingLeaf,
    rejectProtectedProjectLedgerWrites: allowMissingLeaf,
  });
  if (!guarded.ok || !guarded.absolutePath) {
    throw new OperationRejectedError(
      guarded.reason ?? "workspace_path_rejected",
      "The requested path is outside the admitted workspace safety policy.",
    );
  }
  return guarded.absolutePath;
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await visit(root);
  return files.sort((left, right) => sourceRank(left) - sourceRank(right) || left.localeCompare(right));
}

function selected(path: string, args: Record<string, unknown>): boolean {
  return pathMatchesFilters(path, {
    includeGlobs: stringArray(args.include_globs),
    excludeGlobs: stringArray(args.exclude_globs),
  });
}

function sourceRank(path: string): number {
  return /(^|\/)(src|lib|app)(\/|$)/.test(path) ? 0 : 1;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Capability argument must be a string");
  return value;
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
