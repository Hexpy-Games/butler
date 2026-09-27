#!/usr/bin/env bun
/**
 * Token sync: the site's web DS fork (src/ds/tokens.css) must not drift from
 * the app design system tokens. Read-only on app files.
 *
 * - Shared token names must carry identical values in each mapped scope.
 * - Web-only tokens must be prefixed --web-*; any other extra fails.
 * - Unmapped fork scopes (web-only media queries) may hold --web-* only.
 * - App tokens the fork does not copy are reported as info.
 * - Every var(--x) the fork references must be defined by the fork.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export type TokenScopes = Map<string, Map<string, string>>;
export type ScopeMap = Record<string, string>;

export interface SyncReport {
  errors: string[];
  info: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
export const SITE_ROOT = join(here, "..");
export const APP_TOKENS_PATH = join(
  SITE_ROOT, "..", "butler-app", "client", "ui", "src", "libs", "design-system", "tokens.css",
);
export const FORK_TOKENS_PATH = join(SITE_ROOT, "src", "ds", "tokens.css");

const WEB_PREFIX = "--web-";

/** Fork scope -> app scope. The fork's theme scopes map onto the app's .theme-* classes. */
export const FORK_SCOPE_MAP: ScopeMap = {
  ":root": ":root",
  '@media (prefers-color-scheme: dark) :root:not([data-theme="light"])': ".theme-dark",
  ':root[data-theme="dark"]': ".theme-dark",
  ':root[data-theme="light"]': ".theme-light",
  "@media (width <= 640px) :root": "@media (width <= 640px) :root",
  "@media (width <= 640px), (pointer: coarse) :root": "@media (width <= 640px), (pointer: coarse) :root",
  "@media (prefers-reduced-motion: reduce) :root": "@media (prefers-reduced-motion: reduce) :root",
};

export function normalizeValue(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/\(\s+/gu, "(")
    .replace(/\s+\)/gu, ")")
    .replace(/\s*,\s*/gu, ", ")
    .trim();
}

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/gu, " ").replace(/'/gu, '"').trim();
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, "");
}

/** Index of the brace that closes the block opened at `open`. */
function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return css.length;
}

/** Splits a declaration block on `;` outside parentheses. */
function declarations(block: string): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  let depth = 0;
  let start = 0;
  const push = (end: number) => {
    const text = block.slice(start, end);
    const colon = text.indexOf(":");
    if (colon > 0) result.push([text.slice(0, colon).trim(), text.slice(colon + 1)]);
  };
  for (let index = 0; index < block.length; index += 1) {
    const char = block[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === ";" && depth === 0) {
      push(index);
      start = index + 1;
    }
  }
  push(block.length);
  return result;
}

function collect(css: string, context: string, scopes: TokenScopes) {
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    const statementEnd = css.indexOf(";", cursor);
    if (open === -1) return;
    // A top-level statement (@import ...;) before the next block.
    if (statementEnd !== -1 && statementEnd < open && css.slice(cursor, statementEnd).trim().startsWith("@")) {
      cursor = statementEnd + 1;
      continue;
    }
    const prelude = css.slice(cursor, open).trim();
    const close = matchingBrace(css, open);
    const body = css.slice(open + 1, close);
    cursor = close + 1;
    if (prelude.startsWith("@media") || prelude.startsWith("@supports")) {
      collect(body, `${context}${normalizeSelector(prelude)} `, scopes);
      continue;
    }
    if (prelude.startsWith("@")) continue;
    const tokens = declarations(body).filter(([name]) => name.startsWith("--"));
    for (const selector of prelude.split(",")) {
      const key = `${context}${normalizeSelector(selector)}`;
      const scope = scopes.get(key) ?? new Map<string, string>();
      for (const [name, value] of tokens) scope.set(name, normalizeValue(value));
      if (!scopes.has(key)) scopes.set(key, scope);
    }
  }
}

export function parseTokenScopes(css: string): TokenScopes {
  const scopes: TokenScopes = new Map();
  collect(stripComments(css), "", scopes);
  return scopes;
}

function checkReferences(fork: TokenScopes, errors: string[]) {
  const defined = new Set<string>();
  for (const scope of fork.values()) for (const name of scope.keys()) defined.add(name);
  for (const [scopeKey, scope] of fork) {
    for (const [name, value] of scope) {
      for (const match of value.matchAll(/var\((--[\w-]+)/gu)) {
        if (!defined.has(match[1])) errors.push(`${scopeKey}: ${name} references undefined ${match[1]}`);
      }
    }
  }
}

export function compareTokenScopes(app: TokenScopes, fork: TokenScopes, scopeMap: ScopeMap): SyncReport {
  const errors: string[] = [];
  const info: string[] = [];
  for (const [forkKey, appKey] of Object.entries(scopeMap)) {
    if (!app.has(appKey)) errors.push(`app scope "${appKey}" (mapped from "${forkKey}") no longer exists`);
    if (!fork.has(forkKey)) errors.push(`fork scope "${forkKey}" is missing`);
  }
  for (const [forkKey, forkScope] of fork) {
    const appKey = scopeMap[forkKey];
    const appScope = appKey ? app.get(appKey) : undefined;
    for (const [name, value] of forkScope) {
      if (name.startsWith(WEB_PREFIX)) continue;
      if (!appKey) {
        errors.push(`${forkKey}: ${name} is not --web-* and the scope has no app counterpart`);
        continue;
      }
      if (!appScope) continue;
      const appValue = appScope.get(name);
      if (appValue === undefined) {
        errors.push(`${forkKey}: ${name} is not an app token in "${appKey}"; web-only tokens must use ${WEB_PREFIX}*`);
      } else if (appValue !== value) {
        errors.push(`${forkKey}: ${name} drifted (app "${appValue}", fork "${value}")`);
      }
    }
    if (appScope) {
      const missing = [...appScope.keys()].filter((name) => !forkScope.has(name));
      if (missing.length > 0) info.push(`${forkKey}: ${missing.length} app tokens not forked: ${missing.join(", ")}`);
    }
  }
  checkReferences(fork, errors);
  return { errors, info };
}

if (import.meta.main) {
  const verbose = process.argv.includes("--verbose");
  const app = parseTokenScopes(readFileSync(APP_TOKENS_PATH, "utf8"));
  const fork = parseTokenScopes(readFileSync(FORK_TOKENS_PATH, "utf8"));
  const report = compareTokenScopes(app, fork, FORK_SCOPE_MAP);
  const label = `${relative(SITE_ROOT, FORK_TOKENS_PATH)} vs ${relative(SITE_ROOT, APP_TOKENS_PATH)}`;
  for (const line of report.info) {
    console.log(`info: ${verbose ? line : line.replace(/: ([^:]+)$/u, "").trim()}`);
  }
  if (report.errors.length > 0) {
    console.error(`Token sync failed (${label}):`);
    for (const error of report.errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log(`Token sync passed (${label}).`);
}
