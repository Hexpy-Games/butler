import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export interface CanonicalProjectLedgerWork {
  id: string;
  projectId: string;
  status: string;
  ref: string;
}

export function readCanonicalProjectLedgerWorks(
  dataRoot: string,
  projectId: string,
): CanonicalProjectLedgerWork[] {
  const projectsRoot = join(dataRoot, "project-ledger", "projects");
  if (!existsSync(projectsRoot)) return [];
  const records: CanonicalProjectLedgerWork[] = [];
  const projects = directories(projectsRoot).filter((project) =>
    project === projectId,
  );
  for (const project of projects) {
    const workRoot = join(projectsRoot, project, "work");
    for (const work of directories(workRoot)) {
      const path = join(workRoot, work, "work.md");
      if (!existsSync(path)) continue;
      const metadata = frontmatter(readFileSync(path, "utf8"));
      const id = metadata.id || work;
      if (!metadata.status) continue;
      records.push({
        id,
        projectId: project,
        status: metadata.status,
        ref: relative(dataRoot, path),
      });
    }
  }
  return records.sort((left, right) => left.ref.localeCompare(right.ref));
}

export function projectLedgerWorkIdFromEffectTarget(
  target: string,
): string | null {
  const prefix = "project-ledger:work:";
  return target.startsWith(prefix) && target.length > prefix.length
    ? target.slice(prefix.length)
    : null;
}

function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) return {};
  const values: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/u)) {
    const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/u.exec(line);
    if (!field) continue;
    values[field[1]!] = unquote(field[2]!);
  }
  return values;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) return value.slice(1, -1);
  return value;
}
