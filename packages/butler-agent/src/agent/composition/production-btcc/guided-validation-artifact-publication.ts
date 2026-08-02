import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { CommandArtifactEvidence } from
  "../../tools/run-command/run_command/evidence.ts";

export function publishGuidedValidationArtifacts(input: {
  artifactBase: string;
  artifactRoot: string;
  outputPaths: unknown;
  startedAtMs: number;
}): CommandArtifactEvidence[] {
  removeArtifactSymlinks(input.artifactRoot);
  const declared = Array.isArray(input.outputPaths)
    ? input.outputPaths.filter((value): value is string => typeof value === "string")
    : [];
  const candidates = declared.length > 0
    ? declared.map((value) => expandArtifactPath(value, input.artifactRoot))
    : recentArtifactFiles(input.artifactRoot, input.startedAtMs);
  const seen = new Set<string>();
  const accepted: Array<{
    path: string;
    relativePath: string;
  }> = [];
  const canonicalArtifactRoot = realpathSync.native(input.artifactRoot);
  for (const candidate of candidates.slice(0, 24)) {
    const path = resolve(candidate);
    if (!inside(input.artifactRoot, path) || seen.has(path) || !existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile()) continue;
    const real = realpathSync.native(path);
    if (!inside(canonicalArtifactRoot, real)) continue;
    seen.add(path);
    accepted.push({ path, relativePath: relative(input.artifactRoot, path) });
  }
  if (accepted.length === 0) return [];
  const publicationRoot = mkdtempSync(join(input.artifactBase, "validation-"));
  try {
    return accepted.map((candidate) => {
      const publishedPath = join(publicationRoot, candidate.relativePath);
      mkdirSync(dirname(publishedPath), { recursive: true });
      copyRegularFileNoFollow(candidate.path, publishedPath);
      const published = lstatSync(publishedPath);
      if (!published.isFile()) {
        throw new Error("Validation artifact publication produced a non-file entry");
      }
      return {
        path: join(
          "artifacts",
          "generated",
          relative(input.artifactBase, publishedPath),
        ),
        artifact_kind: artifactKind(publishedPath),
        size_bytes: published.size,
        modified_at: new Date(published.mtimeMs).toISOString(),
      } satisfies CommandArtifactEvidence;
    });
  } catch (error) {
    rmSync(publicationRoot, { recursive: true, force: true });
    throw error;
  }
}

function copyRegularFileNoFollow(source: string, destination: string): void {
  const sourceFd = openSync(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let destinationFd: number | null = null;
  try {
    const before = fstatSync(sourceFd);
    if (!before.isFile()) {
      throw new Error("Validation artifact source is not a regular file");
    }
    destinationFd = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        written += writeSync(
          destinationFd,
          buffer,
          written,
          bytesRead - written,
        );
      }
      position += bytesRead;
    }
    const after = fstatSync(sourceFd);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Validation artifact changed during publication");
    }
  } finally {
    if (destinationFd !== null) closeSync(destinationFd);
    closeSync(sourceFd);
  }
}

function removeArtifactSymlinks(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      unlinkSync(path);
    } else if (entry.isDirectory()) {
      removeArtifactSymlinks(path);
    }
  }
}

function recentArtifactFiles(root: string, startedAtMs: number): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= 1_000) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && statSync(path).mtimeMs >= startedAtMs - 100) files.push(path);
    }
  };
  visit(root);
  return files;
}

function expandArtifactPath(value: string, artifactRoot: string): string {
  const trimmed = value.trim();
  for (const token of ["$BUTLER_ARTIFACTS_DIR", "${BUTLER_ARTIFACTS_DIR}"]) {
    if (trimmed === token) return artifactRoot;
    if (trimmed.startsWith(`${token}/`)) return join(artifactRoot, trimmed.slice(token.length + 1));
  }
  return isAbsolute(trimmed) ? trimmed : join(artifactRoot, trimmed);
}

function artifactKind(path: string): CommandArtifactEvidence["artifact_kind"] {
  const extension = extname(path).toLowerCase();
  if (extension === ".csv") return "csv_file";
  if (extension === ".tsv") return "table_file";
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg", ".pdf"].includes(extension)) {
    return "chart_file";
  }
  return "file";
}

function inside(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value === "" || Boolean(value && !value.startsWith("..") && !isAbsolute(value));
}
