import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProjectLedgerCliTrustContext {
  cwd: string;
  workspacePath: string;
  butlerHome?: string;
}

export function isProjectLedgerCliCommand(command: string, context: ProjectLedgerCliTrustContext): boolean {
  const tokens = shellTokens(command);
  if (tokens.length === 0 || hasShellControl(command)) return false;
  if (isEnvAssignment(tokens[0])) return false;

  const commandToken = tokens[0];
  const cliToken = isNodeExecutable(commandToken) ? tokens[1] : commandToken;
  if (!cliToken) return false;
  if (isNodeExecutable(commandToken) && cliToken.startsWith("-")) return false;
  return isTrustedCliPath(cliToken, context);
}

export function looksLikeProjectLedgerCliInvocation(command: string): boolean {
  const tokens = shellTokens(command);
  let index = 0;
  while (index < tokens.length && isEnvAssignment(tokens[index])) index += 1;
  const commandToken = tokens[index];
  if (!commandToken) return false;
  if (isBareProjectLedgerCli(commandToken)) return true;
  const tokensToScan = isNodeExecutable(commandToken) ? tokens.slice(index + 1) : [commandToken];
  return tokensToScan.some(pathLooksLikeProjectLedgerBin);
}

function isTrustedCliPath(token: string, context: ProjectLedgerCliTrustContext): boolean {
  if (!pathLooksLikeProjectLedgerBin(token)) return false;
  const candidate = isAbsolute(token) ? token : resolve(context.cwd, token);
  const trusted = trustedProjectLedgerBins(context);
  return trusted.some((allowed) => sameRealPath(candidate, allowed));
}

function trustedProjectLedgerBins(context: ProjectLedgerCliTrustContext): string[] {
  const roots = uniqueStrings([
    context.butlerHome,
    repoRootFromModule(),
  ].filter((item): item is string => Boolean(item)));
  return roots.flatMap((root) => [
    resolve(root, "packages", "project-ledger", "bin", "project-ledger"),
    resolve(root, "packages", "project-ledger", "bin", "pl"),
  ]);
}

function repoRootFromModule(): string | null {
  const marker = `${resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..", "..")}`;
  return existsSync(resolve(marker, "packages", "project-ledger", "bin", "project-ledger")) ? marker : null;
}

function pathLooksLikeProjectLedgerBin(token: string): boolean {
  return /(?:^|\/)packages\/project-ledger\/bin\/(?:project-ledger|pl)$/u.test(token);
}

function isBareProjectLedgerCli(token: string): boolean {
  return token === "project-ledger" || token === "pl";
}

function isNodeExecutable(token: string | undefined): boolean {
  if (!token) return false;
  if (token === "node") return true;
  return isAbsolute(token) && basename(token) === "node" && sameRealPath(token, process.execPath);
}

function sameRealPath(candidate: string, allowed: string): boolean {
  if (!existsSync(candidate) || !existsSync(allowed)) return false;
  return realpathSync(candidate) === realpathSync(allowed);
}

function hasShellControl(command: string): boolean {
  return /[;&|<>`$()]/u.test(command);
}

function isEnvAssignment(token: string | undefined): boolean {
  return Boolean(token && /^[A-Z_][A-Z0-9_]*=/u.test(token));
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
