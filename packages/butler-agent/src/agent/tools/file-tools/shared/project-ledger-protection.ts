import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ProjectLedgerProtectionInput {
  workspaceRoot: string;
  absolutePath: string;
  explicitProjectLedgerRoots?: string[];
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface ProjectLedgerProtectedPathResult {
  protected: boolean;
  code?: "protected_path";
  protectedRoot?: string;
  message?: string;
  next?: Array<{ command: string }>;
}

const PROJECT_LEDGER_MESSAGE = "Project Ledger source records must be mutated through Project Ledger commands.";
const PROJECT_LEDGER_NEXT = [{ command: "project-ledger record update --id <id> --from FILE|-" }];

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realpathOrNearest(pathValue: string): string {
  let current = resolve(pathValue);
  const suffix: string[] = [];
  while (true) {
    try {
      return join(realpathSync(current), ...suffix.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(pathValue);
      suffix.push(basename(current));
      current = parent;
    }
  }
}

function candidateRoots(input: ProjectLedgerProtectionInput): string[] {
  const env = input.env ?? process.env;
  const roots = [
    join(input.workspaceRoot, ".project-ledger"),
    ...(typeof env.BUTLER_DATA === "string" && env.BUTLER_DATA.trim()
      ? [join(env.BUTLER_DATA, "project-ledger", "projects")]
      : []),
    join(input.homeDir ?? homedir(), ".butler", "project-ledger", "projects"),
    ...(input.explicitProjectLedgerRoots ?? []),
  ];
  return [...new Set(roots.filter((root) => typeof root === "string" && root.trim()).map(realpathOrNearest))];
}

export function projectLedgerProtectedPath(input: ProjectLedgerProtectionInput): ProjectLedgerProtectedPathResult {
  const target = realpathOrNearest(input.absolutePath);
  for (const root of candidateRoots(input)) {
    if (isInside(root, target)) {
      return {
        protected: true,
        code: "protected_path",
        protectedRoot: root,
        message: PROJECT_LEDGER_MESSAGE,
        next: PROJECT_LEDGER_NEXT,
      };
    }
  }
  return { protected: false };
}
