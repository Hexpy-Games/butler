import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { CommandArtifactEvidence } from
  "../../tools/run-command/run_command/evidence.ts";

const MAX_GUIDED_COMMAND_ARTIFACTS = 12;

export function guidedCommandArtifacts(input: {
  outputPaths: unknown;
  butlerData: string;
  startedAtMs?: number;
}): CommandArtifactEvidence[] {
  if (!Array.isArray(input.outputPaths)) return [];
  const artifactRoot = resolve(input.butlerData, "artifacts", "generated");
  const canonicalRoot = canonicalPath(artifactRoot);
  const seen = new Set<string>();
  const artifacts: CommandArtifactEvidence[] = [];
  for (const value of input.outputPaths.slice(0, MAX_GUIDED_COMMAND_ARTIFACTS * 2)) {
    if (typeof value !== "string" || !value.trim()) continue;
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
    if (input.startedAtMs !== undefined && stat.mtimeMs + 1_000 < input.startedAtMs) {
      continue;
    }
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

function expandArtifactPath(
  value: string,
  artifactRoot: string,
  butlerData: string,
): string | null {
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
