#!/usr/bin/env bun
/**
 * Checks the Pages artifact (dist/) after `bun run build`: the CNAME for the
 * configured domain, `/` and every old /docs/ page forwarding into /help/,
 * the site-wide 404.html, the search index, and the DS Viewer at /ds/ with no
 * CNAME or 404.html of its own.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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

  for (const page of pages(file("help")).sort()) {
    const path = relative(dir, page).split("\\").join("/");
    const legacy = path.replace(/^help\//u, "docs/");
    expectRedirect(legacy, `${base}${path.replace(/index\.html$/u, "")}`);
  }

  for (const path of ["404.html", "pagefind/pagefind.js"]) {
    if (!existsSync(file(path))) problems.push(`${path}: missing`);
  }
  if (!existsSync(file("ds/index.html"))) problems.push("ds/index.html: missing (run build:ds)");
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
  console.log("Site dist check passed: /, /help/, /docs/ redirects, 404, search, /ds/ and CNAME.");
}
