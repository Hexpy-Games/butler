import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { projectLedgerProtectedPath } from "../../file-tools/shared/project-ledger-protection.ts";
import {
  isProjectLedgerCliCommand,
  looksLikeProjectLedgerCliInvocation,
} from "./project-ledger-cli-trust.ts";

export interface ProjectLedgerCommandGuardInput {
  command: string;
  cwd: string;
  workspacePath: string;
  butlerData: string;
  butlerHome?: string;
  homeDir?: string;
}

export interface ProjectLedgerCommandGuardResult {
  ok: false;
  error: "protected_path";
  message: string;
  protected_path: string;
  next: Array<{ command: string }>;
}

const DIRECT_WRITE_HINTS = [
  /(?:^|[\s;&|])(?:cat|printf|echo)\b[\s\S]*(?:^|[^&])>{1,2}\s*/u,
  /(?:^|[\s;&|])tee(?:\s+-a)?\s+/u,
  /(?:^|[\s;&|])(?:touch|mkdir|rm|mv|cp|truncate|install|rsync)\b/u,
  /(?:^|[\s;&|])dd\b[^;&|]*\bof=/u,
  /(?:^|[\s;&|])(?:sed|perl)\s+-i\b/u,
  /(?:^|[\s;&|])find\b[\s\S]*\s-delete(?:\s|$)/u,
  /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|write_text)\b/u,
  /\b(?:rmSync|rm|unlinkSync|unlink|rmdirSync|rmdir|renameSync|rename|copyFileSync|copyFile|cpSync|cp|mkdirSync|mkdir)\b/u,
  /\bopen\s*\([^)]*,\s*["'][wax][^"']*["']/u,
];

export function projectLedgerCommandMutationGuard(
  input: ProjectLedgerCommandGuardInput,
): ProjectLedgerCommandGuardResult | null {
  const untrustedCliGuard = untrustedProjectLedgerCliNameGuard(input);
  if (untrustedCliGuard) return untrustedCliGuard;

  const asyncGuard = asynchronousProjectLedgerRiskGuard(input);
  if (asyncGuard) return asyncGuard;

  const writeTargets = protectedWriteTargetCandidates(input.command);
  for (const candidate of writeTargets) {
    const result = protectedPathResult(candidate, input);
    if (result) return result;
  }

  const opaqueGuard = opaqueExecutionGuard(input);
  if (opaqueGuard) return opaqueGuard;

  const protectedMentions = protectedPathCandidates(input.command)
    .map((candidate) => ({ candidate, result: protectedPathResult(candidate, input) }))
    .filter((item): item is { candidate: string; result: ProjectLedgerCommandGuardResult } => item.result !== null);
  if (
    protectedMentions.length > 0
    && !isProjectLedgerCliCommand(input.command, input)
  ) {
    return protectedMentions[0].result;
  }

  return null;
}

function untrustedProjectLedgerCliNameGuard(input: ProjectLedgerCommandGuardInput): ProjectLedgerCommandGuardResult | null {
  if (isProjectLedgerCliCommand(input.command, input)) return null;
  if (!looksLikeProjectLedgerCliInvocation(input.command)) return null;
  return protectedPathResult(".project-ledger", input)
    ?? protectedPathResult("/project-ledger/projects", input)
    ?? protectedPathResult("$HOME/.butler/project-ledger/projects", input);
}

function opaqueExecutionGuard(input: ProjectLedgerCommandGuardInput): ProjectLedgerCommandGuardResult | null {
  if (isProjectLedgerCliCommand(input.command, input)) return null;
  if (!hasOpaqueExecution(input.command)) return null;
  if (!hasEncodedPayload(input.command) && !hasLedgerRiskSignal(input.command)) return null;
  return protectedPathResult(".project-ledger", input)
    ?? protectedPathResult("/project-ledger/projects", input)
    ?? protectedPathResult("$HOME/.butler/project-ledger/projects", input);
}

function asynchronousProjectLedgerRiskGuard(input: ProjectLedgerCommandGuardInput): ProjectLedgerCommandGuardResult | null {
  if (isProjectLedgerCliCommand(input.command, input)) return null;
  if (!hasAsyncExecution(input.command)) return null;
  return protectedPathResult(".project-ledger", input)
    ?? protectedPathResult("/project-ledger/projects", input)
    ?? protectedPathResult("$HOME/.butler/project-ledger/projects", input);
}

function protectedPathCandidates(command: string): string[] {
  return uniqueStrings([
    ...protectedWriteTargetCandidates(command),
    ...projectLedgerPathMentions(command),
  ].map(cleanCandidate).filter((item): item is string => Boolean(item)));
}

function protectedWriteTargetCandidates(command: string): string[] {
  if (!DIRECT_WRITE_HINTS.some((pattern) => pattern.test(command))) return [];
  return uniqueStrings([
    ...redirectionTargets(command),
    ...teeTargets(command),
    ...fileCommandTargets(command),
    ...ddTargets(command),
    ...quotedWriteTargets(command),
    ...delayedWriteTargets(command),
  ].map(cleanCandidate).filter((item): item is string => Boolean(item)));
}

function redirectionTargets(command: string): string[] {
  return [...command.matchAll(/(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*([^\s;&|]+)/gu)].map((match) => match[1] ?? "");
}

function teeTargets(command: string): string[] {
  return [...command.matchAll(/(?:^|[\s;&|])tee(?:\s+-a)?\s+([^\s;&|]+)/gu)].map((match) => match[1] ?? "");
}

function fileCommandTargets(command: string): string[] {
  const targets: string[] = [];
  const commandMatches = command.matchAll(/(?:^|[\s;&|])(?:touch|mkdir|rm|mv|cp|truncate|install|rsync)\b([^;&|]*)/gu);
  for (const match of commandMatches) {
    targets.push(...shellWords(match[1] ?? ""));
  }
  const inPlaceMatches = command.matchAll(/(?:^|[\s;&|])(?:sed|perl)\s+-i\b([^;&|]*)/gu);
  for (const match of inPlaceMatches) {
    targets.push(...shellWords(match[1] ?? ""));
  }
  return targets;
}

function ddTargets(command: string): string[] {
  return [...command.matchAll(/(?:^|[\s;&|])dd\b[^;&|]*\bof=([^\s;&|]+)/gu)].map((match) => match[1] ?? "");
}

function quotedWriteTargets(command: string): string[] {
  if (!/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|write_text|open\s*\()/u.test(command)) {
    return [];
  }
  return [
    ...[...command.matchAll(/["']([^"']*(?:\.project-ledger|project-ledger\/projects|\.butler\/project-ledger)[^"']*)["']/gu)]
      .map((match) => match[1] ?? ""),
    ...[...command.matchAll(/process\.env\.BUTLER_DATA\s*\+\s*["'](\/project-ledger\/projects[^"']*)["']/gu)]
      .map((match) => match[1] ?? ""),
    ...[...command.matchAll(/process\.env\.HOME\s*\+\s*["'](\/\.butler\/project-ledger\/projects[^"']*)["']/gu)]
      .map((match) => match[1] ?? ""),
    ...[...command.matchAll(/process\.cwd\(\)\s*\+\s*["'](\/\.project-ledger[^"']*)["']/gu)]
      .map((match) => match[1] ?? ""),
    ...expressionBuiltTargets(command),
  ];
}

function delayedWriteTargets(command: string): string[] {
  if (!hasWriteApi(command)) return [];
  if (!hasAsyncExecution(command)) return [];
  const targets: string[] = [];
  if (/process\.cwd\(\)/u.test(command)) targets.push(".project-ledger");
  if (/process\.env\.BUTLER_DATA/u.test(command)) targets.push("/project-ledger/projects");
  if (/process\.env\.HOME/u.test(command)) targets.push("$HOME/.butler/project-ledger/projects");
  return targets;
}

function hasWriteApi(command: string): boolean {
  return /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|write_text|open\s*\()\b/u.test(command);
}

function hasAsyncExecution(command: string): boolean {
  return /(?:\bdetached\b|\bnohup\b|\bsetsid\b|\bdisown\b|\bunref\s*\(|setTimeout\s*\(|spawn\s*\()/u.test(command) ||
    /(?:\bfork\s*\(|\bos\.fork\b|\bsubprocess\b|\bPopen\b|\bdaemon\b|\bstart_new_session\b|\bmultiprocessing\b)/u.test(command) ||
    /(?:^|[^&>])&(?![&>])/u.test(command);
}

function hasOpaqueExecution(command: string): boolean {
  return /(?:\b(?:node|bun)\s+(?:-e|--eval)\b|\bpython3?\s+-c\b|\bruby\s+-e\b|\bperl\s+-e\b|\bphp\s+-r\b|\beval\b|base64\s+-d|Buffer\.from|atob\s*\()/u
    .test(command);
}

function hasEncodedPayload(command: string): boolean {
  return /(?:\beval\b|\bexec\s*\(|\bcompile\s*\(|base64\b|b64decode|fromhex|codecs\.decode|marshal\b|pickle\b|base64\s+-d|Buffer\.from|atob\s*\()/u
    .test(command);
}

function hasLedgerRiskSignal(command: string): boolean {
  return /(?:project.?ledger|\.project|\.butler|BUTLER_DATA|BUTLER[^;\n]{0,24}_DATA|HOME|process|cwd|String\.fromCharCode|Buffer\.from|spawn|child_process)/u
    .test(command);
}

function expressionBuiltTargets(command: string): string[] {
  const literals = [...command.matchAll(/["']([^"']*)["']/gu)].map((match) => match[1] ?? "");
  const joinedLiterals = literals.join("");
  const targets: string[] = [];
  if (
    /process\.cwd\(\)/u.test(command) &&
    (joinedLiterals.includes("/.project-ledger") || (command.includes("/.project") && command.includes("-ledger")))
  ) {
    targets.push(".project-ledger");
  }
  if (
    /process\.env\.BUTLER_DATA/u.test(command) &&
    (joinedLiterals.includes("/project-ledger/projects") || (command.includes("project-ledger") && command.includes("projects")))
  ) {
    targets.push("/project-ledger/projects");
  }
  if (
    /process\.env\.HOME/u.test(command) &&
    (
      joinedLiterals.includes("/.butler/project-ledger/projects") ||
      (command.includes(".butler") && command.includes("project-ledger") && command.includes("projects"))
    )
  ) {
    targets.push("$HOME/.butler/project-ledger/projects");
  }
  return targets;
}

function projectLedgerPathMentions(command: string): string[] {
  return [
    ...command.matchAll(/(?:^|[\s"'])(\.project-ledger(?:\/[^\s"';&|)]*)?)/gu),
    ...command.matchAll(/(?:^|[\s"'])((?:\$BUTLER_DATA|\$\{BUTLER_DATA\}|~\/\.butler)\/project-ledger\/projects(?:\/[^\s"';&|)]*)?)/gu),
    ...command.matchAll(/(?:^|[\s"'])((?:\$HOME|\$\{HOME\})\/\.butler\/project-ledger\/projects(?:\/[^\s"';&|)]*)?)/gu),
    ...command.matchAll(/(?:^|[\s"'])(\/[^\s"']*\/project-ledger\/projects(?:\/[^\s"';&|)]*)?)/gu),
  ].map((match) => match[1] ?? "");
}

function shellWords(value: string): string[] {
  return value
    .split(/\s+/u)
    .map((item) => item.trim())
    .filter((item) => item && !item.startsWith("-"));
}

function cleanCandidate(value: string): string | null {
  const cleaned = value
    .trim()
    .replace(/^[`"']+/u, "")
    .replace(/[`"',;|)]+$/u, "");
  return cleaned.length > 0 ? cleaned : null;
}

function resolveCommandPath(candidate: string, input: ProjectLedgerCommandGuardInput): string | null {
  const homeDir = input.homeDir ?? homedir();
  if (candidate.startsWith("$BUTLER_DATA/")) {
    return resolve(input.butlerData, candidate.slice("$BUTLER_DATA/".length));
  }
  if (candidate.startsWith("${BUTLER_DATA}/")) {
    return resolve(input.butlerData, candidate.slice("${BUTLER_DATA}/".length));
  }
  if (candidate.startsWith("$HOME/")) {
    return resolve(homeDir, candidate.slice("$HOME/".length));
  }
  if (candidate.startsWith("${HOME}/")) {
    return resolve(homeDir, candidate.slice("${HOME}/".length));
  }
  if (candidate.startsWith("/project-ledger/projects/")) return resolve(input.butlerData, candidate.slice(1));
  if (candidate.startsWith("/.project-ledger/")) return resolve(input.cwd, candidate.slice(1));
  if (candidate.startsWith("~/")) return resolve(homeDir, candidate.slice(2));
  if (isAbsolute(candidate)) return resolve(candidate);
  if (candidate.startsWith("project-ledger/projects/")) return resolve(input.butlerData, candidate);
  if (candidate.startsWith(".project-ledger/")) return resolve(input.cwd, candidate);
  return resolve(input.cwd, candidate);
}

function protectedPathResult(
  candidate: string,
  input: ProjectLedgerCommandGuardInput,
): ProjectLedgerCommandGuardResult | null {
  const absolutePath = resolveCommandPath(candidate, input);
  if (!absolutePath) return null;
  const protectedPath = projectLedgerProtectedPath({
    workspaceRoot: input.workspacePath,
    absolutePath,
    env: { ...process.env, BUTLER_DATA: input.butlerData },
    homeDir: input.homeDir ?? homedir(),
  });
  if (!protectedPath.protected) return null;
  return {
    ok: false,
    error: "protected_path",
    message: protectedPath.message ?? "Project Ledger records must be mutated through Project Ledger commands.",
    protected_path: candidate,
    next: protectedPath.next ?? [{ command: "project-ledger record update --id <id> --from FILE|-" }],
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
