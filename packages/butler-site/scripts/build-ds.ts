#!/usr/bin/env bun
/**
 * Adds the DS Viewer to the site at /ds/: runs the existing static DS build in
 * packages/butler-app/client/ui (`build:ds-site:ds`, DS_SITE_BASE=/ds/; see
 * ds-site/README.md there) and copies its output as-is to dist/ds/. That build
 * has no CNAME or 404.html: the site owns both, and its 404.html loads the
 * build's ds-404-redirect.js. Run after the manual build (astro empties dist/).
 * The client/ui dependencies come from `npm ci` there, as in CI.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { designSystemRoot } from "../src/site/nav";
import { SITE_ROOT } from "./check-token-sync";
import { resolveDeployTarget } from "./deploy-target";

const UI_ROOT = join(SITE_ROOT, "..", "butler-app", "client", "ui");
const DS_OUT = join(UI_ROOT, "dist-ds-site-ds");
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

if (import.meta.main) {
  const dsBase = designSystemRoot(resolveDeployTarget().base);
  if (!existsSync(join(SITE_DIST, "index.html"))) {
    console.error("dist/ has no site yet: run the manual build (build:help) before build:ds.");
    process.exit(1);
  }
  execFileSync("npm", ["--prefix", UI_ROOT, "run", "build:ds-site:ds"], { stdio: "inherit" });
  const index = join(DS_OUT, "index.html");
  const problems = existsSync(index) ? dsAssetProblems(readFileSync(index, "utf8"), dsBase) : [`${index} is missing`];
  if (problems.length > 0) {
    console.error(`The DS build is not a ${dsBase} build (build:ds-site:ds in client/ui):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const target = join(SITE_DIST, "ds");
  rmSync(target, { recursive: true, force: true });
  cpSync(DS_OUT, target, { recursive: true });
  console.log(`DS Viewer copied to dist/ds/ (base ${dsBase}).`);
}
