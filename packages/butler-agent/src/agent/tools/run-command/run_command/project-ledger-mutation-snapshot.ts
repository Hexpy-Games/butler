import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isProjectLedgerCliCommand } from "./project-ledger-cli-trust.ts";

export interface ProjectLedgerMutationSnapshot {
  roots: ProjectLedgerSnapshotRoot[];
  backupDir: string;
}

export interface ProjectLedgerSnapshotRoot {
  root: string;
  backup: string;
  before: string;
  existed: boolean;
}

export interface ProjectLedgerMutationViolation {
  error: "protected_path";
  message: string;
  protected_path: string;
  next: Array<{ command: string }>;
}

const PROJECT_LEDGER_MUTATION_MESSAGE =
  "Project Ledger source records must be mutated through Project Ledger commands.";
const PROJECT_LEDGER_NEXT = [{ command: "project-ledger record update --id <id> --from FILE|-" }];

export function createProjectLedgerMutationSnapshot(input: {
  command: string;
  cwd: string;
  workspacePath: string;
  butlerData: string;
  butlerHome?: string;
}): ProjectLedgerMutationSnapshot | null {
  if (isProjectLedgerCliCommand(input.command, input)) return null;
  if (!mayMutateProjectLedger(input.command) && !hasOpaqueExecution(input.command)) return null;
  const roots = protectedRoots(input.workspacePath, input.butlerData, {
    includeHome: mayTouchHomeFallback(input.command),
  });
  if (roots.length === 0) return null;
  const backupDir = mkdtempSync(join(tmpdir(), "butler-project-ledger-snapshot-"));
  return {
    backupDir,
    roots: roots.map((root, index) => {
      const backup = join(backupDir, `root-${index}`);
      const existed = existsSync(root);
      if (existed) cpSync(root, backup, { recursive: true, errorOnExist: false, force: true, verbatimSymlinks: true });
      return {
        root,
        backup,
        existed,
        before: treeFingerprint(root),
      };
    }),
  };
}

export function restoreProjectLedgerMutationIfChanged(
  snapshot: ProjectLedgerMutationSnapshot | null,
): ProjectLedgerMutationViolation | null {
  if (!snapshot) return null;
  const changed = snapshot.roots.find((root) => treeFingerprint(root.root) !== root.before);
  if (!changed) return null;
  for (const root of snapshot.roots) {
    rmSync(root.root, { recursive: true, force: true });
    if (!root.existed) continue;
    mkdirSync(dirname(root.root), { recursive: true });
    cpSync(root.backup, root.root, { recursive: true, errorOnExist: false, force: true, verbatimSymlinks: true });
  }
  return {
    error: "protected_path",
    message: PROJECT_LEDGER_MUTATION_MESSAGE,
    protected_path: changed.root,
    next: PROJECT_LEDGER_NEXT,
  };
}

export function cleanupProjectLedgerMutationSnapshot(snapshot: ProjectLedgerMutationSnapshot | null): void {
  if (!snapshot) return;
  rmSync(snapshot.backupDir, { recursive: true, force: true });
}

function protectedRoots(workspacePath: string, butlerData: string, options: { includeHome: boolean }): string[] {
  const roots = [
    resolve(workspacePath, ".project-ledger"),
    resolve(butlerData, "project-ledger", "projects"),
  ];
  if (options.includeHome) {
    roots.push(resolve(process.env.HOME ?? homedir(), ".butler", "project-ledger", "projects"));
  }
  return uniqueStrings(roots);
}

function mayMutateProjectLedger(command: string): boolean {
  const hasWriteIntent =
    /(?:^|[\s;&|])(?:cat|printf|echo)\b[\s\S]*(?:^|[^&])>{1,2}\s*/u.test(command) ||
    /(?:^|[\s;&|])(?:tee|touch|mkdir|rm|mv|cp|truncate|install|rsync|dd|sed|perl)\b/u.test(command) ||
    /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|write_text|open\s*\()\b/u.test(command) ||
    /\b(?:rmSync|rm|unlinkSync|unlink|rmdirSync|rmdir|renameSync|rename|copyFileSync|copyFile|cpSync|cp|mkdirSync|mkdir)\b/u.test(command) ||
    hasFileSystemSurface(command);
  if (!hasWriteIntent) return false;
  return /(?:project.?ledger|\.project|\.butler|BUTLER|HOME|process|cwd|env|String\.fromCharCode|Buffer\.from)/u
    .test(command);
}

function hasFileSystemSurface(command: string): boolean {
  return /(?:require\s*\(\s*["'](?:node:)?fs["']\s*\)|import\s*\(\s*["'](?:node:)?fs["']\s*\)|from\s+["'](?:node:)?fs["']|\bfs\s*[[.]|\bpromises\s*[[.]|\bDeno\s*\.|\bBun\s*\.)/u
    .test(command);
}

function hasOpaqueExecution(command: string): boolean {
  return /(?:\b(?:node|bun)\s+-e\b|\bpython3?\s+-c\b|\bruby\s+-e\b|\bperl\s+-e\b|\bphp\s+-r\b|\beval\b|base64\s+-d|Buffer\.from|atob\s*\()/u
    .test(command);
}

function mayTouchHomeFallback(command: string): boolean {
  return /(?:\$HOME|\$\{HOME\}|~\/\.butler|process\.env\.HOME|\.butler\/project-ledger)/u.test(command);
}

function treeFingerprint(root: string): string {
  if (!existsSync(root)) return "absent";
  const entries: string[] = [];
  walk(root, root, entries);
  return entries.sort().join("\n");
}

function walk(root: string, current: string, entries: string[]): void {
  const stat = lstatSync(current);
  const rel = relative(root, current) || ".";
  if (stat.isSymbolicLink()) {
    entries.push(`link:${rel}:${readlinkSync(current)}`);
    return;
  }
  if (stat.isDirectory()) {
    entries.push(`dir:${rel}`);
    for (const child of readdirSync(current)) walk(root, join(current, child), entries);
    return;
  }
  if (stat.isFile()) {
    entries.push(`file:${rel}:${stat.mode}:${sha256(current)}`);
    return;
  }
  entries.push(`other:${rel}:${stat.mode}:${stat.size}`);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
