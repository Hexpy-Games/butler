#!/usr/bin/env bun
/**
 * Adds the DS Viewer to the site at /ds/: runs the existing static DS build in
 * packages/butler-app/client/ui (`build:ds-site`, DS_SITE_BASE=/ds/) and copies
 * its output to dist/ds/. Run after the manual build (astro empties dist/).
 * The client/ui dependencies come from `npm ci` there, as in CI.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { designSystemRoot } from "../src/site/nav";
import { SITE_ROOT } from "./check-token-sync";
import { resolveDeployTarget } from "./deploy-target";

const UI_ROOT = join(SITE_ROOT, "..", "butler-app", "client", "ui");
const DS_OUT = join(UI_ROOT, "dist-ds-site");
const SITE_DIST = join(SITE_ROOT, "dist");

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|#)/iu;

/** Script and stylesheet URLs of the built index.html that do not live under the /ds/ base. */
export function dsAssetProblems(indexHtml: string, dsBase: string): string[] {
  const refs = [...indexHtml.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((ref) => !EXTERNAL.test(ref));
  if (refs.length === 0) return ["no script or stylesheet in index.html"];
  return refs.filter((ref) => !ref.startsWith(dsBase)).map((ref) => `${ref} is not under ${dsBase}`);
}

/** The site root owns CNAME and 404.html (which forwards /ds/<path> links). */
export function keepInDs(path: string): boolean {
  return path !== "CNAME" && path !== "404.html";
}

if (import.meta.main) {
  const dsBase = designSystemRoot(resolveDeployTarget().base);
  if (!existsSync(join(SITE_DIST, "index.html"))) {
    console.error("dist/ has no site yet: run the manual build (astro build) before build:ds.");
    process.exit(1);
  }
  execFileSync("npm", ["--prefix", UI_ROOT, "run", "build:ds-site"], {
    stdio: "inherit",
    env: { ...process.env, DS_SITE_BASE: dsBase },
  });
  const problems = dsAssetProblems(readFileSync(join(DS_OUT, "index.html"), "utf8"), dsBase);
  if (problems.length > 0) {
    console.error(`The DS build ignored DS_SITE_BASE=${dsBase}; client/ui needs the DS site base-path support:`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const target = join(SITE_DIST, "ds");
  rmSync(target, { recursive: true, force: true });
  cpSync(DS_OUT, target, { recursive: true, filter: (source) => keepInDs(relative(DS_OUT, source).split("\\").join("/")) });
  console.log(`DS Viewer copied to dist/ds/ (base ${dsBase}).`);
}
