import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { CommandArtifactEvidence } from
  "../../tools/run-command/run_command/evidence.ts";

const MAX_DECLARED_ARTIFACTS = 12;
const MAX_DECLARED_ARTIFACT_BYTES = 10 * 1024 * 1024;
const GENERATED_ARTIFACT_LABEL = "artifacts/generated/";

export type GuidedDeclaredArtifactPublication = {
  requested: number;
  artifacts: CommandArtifactEvidence[];
};

export function publishGuidedDeclaredArtifacts(input: {
  outputPaths: unknown;
  butlerData: string;
  workspacePath: string;
  cwd: string;
}): GuidedDeclaredArtifactPublication {
  const outputPaths = declaredOutputPaths(input.outputPaths);
  const generatedRoot = resolve(input.butlerData, "artifacts", "generated");
  if (outputPaths.length > 0) mkdirSync(generatedRoot, { recursive: true });
  const butlerDataRoot = canonicalPath(input.butlerData);
  const workspaceRoot = canonicalPath(input.workspacePath);
  const canonicalGeneratedRoot = canonicalPath(generatedRoot);
  if (!isInside(butlerDataRoot, canonicalGeneratedRoot)) {
    return { requested: outputPaths.length, artifacts: [] };
  }
  const artifacts: CommandArtifactEvidence[] = [];
  const seen = new Set<string>();

  for (const outputPath of outputPaths) {
    const source = declaredSourcePath({
      outputPath,
      butlerData: input.butlerData,
      generatedRoot,
      cwd: input.cwd,
    });
    const verified = source
      ? verifiedDeclaredSource({
          source,
          workspaceRoot,
          generatedRoot: canonicalGeneratedRoot,
        })
      : null;
    if (!verified) continue;

    const published = isInside(canonicalGeneratedRoot, verified.realPath)
      ? verified.realPath
      : publishWorkspaceFile({
          bytes: verified.bytes,
          sourceName: basename(verified.realPath),
          generatedRoot: canonicalGeneratedRoot,
        });
    if (!published) continue;
    const canonicalPublished = canonicalPath(published);
    if (!isInside(canonicalGeneratedRoot, canonicalPublished)) continue;
    const label = `${GENERATED_ARTIFACT_LABEL}${relative(
      canonicalGeneratedRoot,
      canonicalPublished,
    ).split("\\").join("/")}`;
    if (seen.has(label)) continue;
    const stat = lstatSync(canonicalPublished);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) continue;
    seen.add(label);
    artifacts.push({
      path: label,
      artifact_kind: artifactKind(canonicalPublished),
      size_bytes: stat.size,
      modified_at: new Date(stat.mtimeMs).toISOString(),
    });
    if (artifacts.length >= MAX_DECLARED_ARTIFACTS) break;
  }

  return { requested: outputPaths.length, artifacts };
}

function declaredOutputPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_DECLARED_ARTIFACTS * 2);
}

function declaredSourcePath(input: {
  outputPath: string;
  butlerData: string;
  generatedRoot: string;
  cwd: string;
}): string | null {
  if (input.outputPath.startsWith(GENERATED_ARTIFACT_LABEL)) {
    const candidate = resolve(
      input.generatedRoot,
      input.outputPath.slice(GENERATED_ARTIFACT_LABEL.length),
    );
    return isInside(input.generatedRoot, candidate) ? candidate : null;
  }
  const replacements: Array<[string, string]> = [
    ["${BUTLER_ARTIFACTS_DIR}", input.generatedRoot],
    ["$BUTLER_ARTIFACTS_DIR", input.generatedRoot],
    ["${BUTLER_ARTIFACT_DIR}", input.generatedRoot],
    ["$BUTLER_ARTIFACT_DIR", input.generatedRoot],
    ["${BUTLER_DATA}", input.butlerData],
    ["$BUTLER_DATA", input.butlerData],
  ];
  let expanded = input.outputPath;
  for (const [token, replacement] of replacements) {
    if (expanded === token) expanded = replacement;
    else if (expanded.startsWith(`${token}/`)) {
      expanded = join(replacement, expanded.slice(token.length + 1));
    }
  }
  return isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(input.cwd, expanded);
}

function verifiedDeclaredSource(input: {
  source: string;
  workspaceRoot: string;
  generatedRoot: string;
}): { realPath: string; bytes: Buffer } | null {
  if (!existsSync(input.source)) return null;
  try {
    const linkStat = lstatSync(input.source);
    if (
      !linkStat.isFile() || linkStat.isSymbolicLink() || linkStat.size <= 0 ||
      linkStat.size > MAX_DECLARED_ARTIFACT_BYTES
    ) return null;
    const realPath = realpathSync.native(input.source);
    if (
      !isInside(input.workspaceRoot, realPath) &&
      !isInside(input.generatedRoot, realPath)
    ) return null;
    const before = lstatSync(realPath);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    const bytes = readFileSync(realPath);
    const after = lstatSync(realPath);
    if (
      bytes.byteLength !== before.size || before.dev !== after.dev ||
      before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) return null;
    return { realPath, bytes };
  } catch {
    return null;
  }
}

function publishWorkspaceFile(input: {
  bytes: Buffer;
  sourceName: string;
  generatedRoot: string;
}): string | null {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const directory = join(input.generatedRoot, "published", sha256);
  const destination = join(directory, safeFileName(input.sourceName));
  try {
    mkdirSync(directory, { recursive: true });
    if (!safePublicationDirectory(input.generatedRoot, directory)) return null;
    if (existsSync(destination)) {
      return sameBytes(destination, input.bytes) ? destination : null;
    }
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, input.bytes, { flag: "wx", mode: 0o600 });
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
    return sameBytes(destination, input.bytes) ? destination : null;
  } catch {
    return existsSync(destination) && sameBytes(destination, input.bytes)
      ? destination
      : null;
  }
}

function safePublicationDirectory(root: string, directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      isInside(root, realpathSync.native(directory));
  } catch {
    return false;
  }
}

function sameBytes(path: string, expected: Buffer): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.byteLength) {
      return false;
    }
    return createHash("sha256").update(readFileSync(path)).digest("hex") ===
      createHash("sha256").update(expected).digest("hex");
  } catch {
    return false;
  }
}

function safeFileName(value: string): string {
  const normalized = basename(value)
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}_ .@()+\-[\]]+/gu, "_")
    .trim();
  return (normalized && normalized !== "." && normalized !== ".."
    ? normalized
    : "attachment").slice(0, 120);
}

function artifactKind(path: string): CommandArtifactEvidence["artifact_kind"] {
  const extension = extname(path).toLocaleLowerCase("en-US");
  if (extension === ".csv") return "csv_file";
  if (extension === ".tsv") return "table_file";
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg", ".pdf"].includes(extension)) {
    return "chart_file";
  }
  return "file";
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isInside(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value === "" || Boolean(
    value && value !== ".." && !value.startsWith(`..${sep}`) &&
      !isAbsolute(value),
  );
}
