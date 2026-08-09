import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { CommandArtifactEvidence } from
  "../../tools/run-command/run_command/evidence.ts";

const MAX_GUIDED_COMMAND_ARTIFACTS = 12;
const MAX_GUIDED_ARTIFACT_SCAN_FILES = 20_000;
const MAX_GUIDED_ARTIFACT_SCAN_DEPTH = 8;

export type GuidedCommandArtifactSnapshot = ReadonlyMap<string, string>;

type GeneratedArtifactFile = {
  relativePath: string;
  realPath: string;
  fingerprint: string;
  sizeBytes: number;
  modifiedAtMs: number;
};

export function snapshotGuidedCommandArtifacts(input: {
  butlerData: string;
}): GuidedCommandArtifactSnapshot {
  return new Map(scanGeneratedArtifacts(input.butlerData).map((file) => [
    file.relativePath,
    file.fingerprint,
  ]));
}

export function guidedCommandArtifacts(input: {
  outputPaths: unknown;
  butlerData: string;
  startedAtMs: number;
  before: GuidedCommandArtifactSnapshot;
}): CommandArtifactEvidence[] {
  const outputPaths = Array.isArray(input.outputPaths)
    ? input.outputPaths.filter((value): value is string =>
        typeof value === "string" && Boolean(value.trim()))
    : [];
  if (outputPaths.length === 0) return discoveredGeneratedArtifacts(input);

  const artifactRoot = resolve(input.butlerData, "artifacts", "generated");
  const canonicalRoot = canonicalPath(artifactRoot);
  const seen = new Set<string>();
  const artifacts: CommandArtifactEvidence[] = [];
  for (const value of outputPaths.slice(0, MAX_GUIDED_COMMAND_ARTIFACTS * 2)) {
    const candidate = expandArtifactPath(value.trim(), artifactRoot, input.butlerData);
    if (!candidate || seen.has(candidate) || !existsSync(candidate)) continue;
    let stat;
    try {
      const linkStat = lstatSync(candidate);
      if (!linkStat.isFile() || linkStat.isSymbolicLink()) continue;
      const real = realpathSync.native(candidate);
      if (!isInside(canonicalRoot, real)) continue;
      stat = lstatSync(real);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) continue;
    if (stat.mtimeMs + 1_000 < input.startedAtMs) continue;
    seen.add(candidate);
    artifacts.push({
      path: join(
        "artifacts",
        "generated",
        relative(canonicalRoot, realpathSync.native(candidate)),
      ).split("\\").join("/"),
      artifact_kind: artifactKind(candidate),
      size_bytes: stat.size,
      modified_at: new Date(stat.mtimeMs).toISOString(),
    });
    if (artifacts.length >= MAX_GUIDED_COMMAND_ARTIFACTS) break;
  }
  return artifacts;
}

function discoveredGeneratedArtifacts(input: {
  butlerData: string;
  before: GuidedCommandArtifactSnapshot;
}): CommandArtifactEvidence[] {
  return scanGeneratedArtifacts(input.butlerData)
    .filter((file) => input.before.get(file.relativePath) !== file.fingerprint)
    .filter((file) => file.sizeBytes > 0)
    .slice(0, MAX_GUIDED_COMMAND_ARTIFACTS)
    .map((file) => ({
      path: `artifacts/generated/${file.relativePath}`,
      artifact_kind: artifactKind(file.realPath),
      size_bytes: file.sizeBytes,
      modified_at: new Date(file.modifiedAtMs).toISOString(),
    }));
}

function scanGeneratedArtifacts(butlerData: string): GeneratedArtifactFile[] {
  const artifactRoot = resolve(butlerData, "artifacts", "generated");
  if (!existsSync(artifactRoot)) return [];
  const canonicalRoot = canonicalPath(artifactRoot);
  const files: GeneratedArtifactFile[] = [];
  let scanned = 0;
  const visit = (directory: string, depth: number) => {
    if (
      depth > MAX_GUIDED_ARTIFACT_SCAN_DEPTH ||
      scanned >= MAX_GUIDED_ARTIFACT_SCAN_FILES
    ) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= MAX_GUIDED_ARTIFACT_SCAN_FILES) return;
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(candidate, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      try {
        const realPath = realpathSync.native(candidate);
        if (!isInside(canonicalRoot, realPath)) continue;
        const stat = lstatSync(realPath);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const relativePath = relative(canonicalRoot, realPath)
          .split("\\").join("/");
        if (!relativePath || relativePath.startsWith("../")) continue;
        files.push({
          relativePath,
          realPath,
          fingerprint: [
            stat.dev,
            stat.ino,
            stat.size,
            stat.mtimeMs,
            stat.ctimeMs,
          ].join(":"),
          sizeBytes: stat.size,
          modifiedAtMs: stat.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  };
  visit(artifactRoot, 0);
  return files;
}

function expandArtifactPath(
  value: string,
  artifactRoot: string,
  butlerData: string,
): string | null {
  const generatedLabel = "artifacts/generated/";
  if (value.startsWith(generatedLabel)) {
    return resolve(artifactRoot, value.slice(generatedLabel.length));
  }
  const replacements: Array<[string, string]> = [
    ["${BUTLER_ARTIFACTS_DIR}", artifactRoot],
    ["$BUTLER_ARTIFACTS_DIR", artifactRoot],
    ["${BUTLER_ARTIFACT_DIR}", artifactRoot],
    ["$BUTLER_ARTIFACT_DIR", artifactRoot],
    ["${BUTLER_DATA}", butlerData],
    ["$BUTLER_DATA", butlerData],
  ];
  let expanded = value;
  for (const [token, replacement] of replacements) {
    if (expanded === token) expanded = replacement;
    else if (expanded.startsWith(`${token}/`)) {
      expanded = join(replacement, expanded.slice(token.length + 1));
    }
  }
  if (!isAbsolute(expanded)) return null;
  const resolved = resolve(expanded);
  return isInside(artifactRoot, resolved) ? resolved : null;
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
  return value === "" || Boolean(value && !value.startsWith("..") && !isAbsolute(value));
}
