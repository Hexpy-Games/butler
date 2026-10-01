#!/usr/bin/env bun
/**
 * Checks the Pages artifact (dist/) after `bun run build`: the CNAME for the
 * configured domain, `/` and every old /docs/ page forwarding into /help/,
 * each locale's manual (/help/, /en/help/) with its <html lang> and its own
 * search index, the site-wide 404.html loading the DS redirect helper, and
 * the DS Viewer at /ds/ with no CNAME or 404.html of its own.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DS_REDIRECT_HELPER, designSystemRoot, docsRoot } from "../src/site/nav";
import { LOCALES } from "../src/site/sections";
import { SITE_ROOT } from "./check-token-sync";
import { resolveDeployTarget } from "./deploy-target";

interface Target {
  base: string;
  domain: string;
}

function pages(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === "index.html" ? [path] : [];
  });
}

export function checkDist(dir: string, { base, domain }: Target): string[] {
  const problems: string[] = [];
  const file = (path: string) => join(dir, path);
  const read = (path: string) => (existsSync(file(path)) ? readFileSync(file(path), "utf8") : undefined);
  const expectRedirect = (path: string, to: string) => {
    const html = read(path);
    if (html === undefined) problems.push(`${path}: missing (redirect to ${to})`);
    else if (!html.includes(`url=${to}"`)) problems.push(`${path}: does not redirect to ${to}`);
  };

  const cname = read("CNAME")?.trim();
  if (cname !== domain) problems.push(`CNAME: expected ${domain}, got ${cname ?? "nothing"}`);
  const help = `${base}help/`;
  const root = read("index.html");
  if (root === undefined || !root.includes(`url=${help}"`)) problems.push(`index.html: does not redirect to ${help}`);

  const built = (root: string) => pages(file(root)).map((page) => relative(dir, page).split("\\").join("/")).sort();
  for (const path of built("help")) {
    const legacy = path.replace(/^help\//u, "docs/");
    expectRedirect(legacy, `${base}${path.replace(/index\.html$/u, "")}`);
  }

  // Each locale: a landing page, <html lang> on every page, and (once it has
  // pages to search) its own Pagefind index, which Pagefind picks by that lang.
  const searchIndexes = Object.keys((JSON.parse(read("pagefind/pagefind-entry.json") ?? "{}") as { languages?: object }).languages ?? {});
  for (const locale of LOCALES) {
    const root = docsRoot("/", locale).slice(1);
    const localePages = built(root);
    if (!localePages.includes(`${root}index.html`)) problems.push(`${root}index.html: missing (the ${locale} manual)`);
    for (const path of localePages) {
      if (!read(path)?.includes(`<html lang="${locale}"`)) problems.push(`${path}: is not <html lang="${locale}">`);
    }
    if (localePages.length > 1 && !searchIndexes.includes(locale)) problems.push(`pagefind: no ${locale} search index`);
  }

  const dsHelper = `${designSystemRoot(base)}${DS_REDIRECT_HELPER}`;
  if (!read("404.html")?.includes(`src="${dsHelper}"`)) problems.push(`404.html: does not load ${dsHelper}`);
  if (!existsSync(file("pagefind/pagefind.js"))) problems.push("pagefind/pagefind.js: missing");
  if (!existsSync(file("ds/index.html"))) problems.push("ds/index.html: missing (run build:ds)");
  if (!existsSync(file(`ds/${DS_REDIRECT_HELPER}`))) problems.push(`ds/${DS_REDIRECT_HELPER}: missing`);
  for (const path of ["ds/CNAME", "ds/404.html"]) {
    if (existsSync(file(path))) problems.push(`${path}: only the site root may have one`);
  }
  return problems;
}

if (import.meta.main) {
  const dist = join(SITE_ROOT, "dist");
  const problems = checkDist(dist, resolveDeployTarget());
  if (problems.length > 0) {
    console.error(`Site dist check failed (${dist}):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log("Site dist check passed: /, /help/, /en/help/, /docs/ redirects, 404, per-locale search, /ds/ and CNAME.");
}
