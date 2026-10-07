import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectFontAssets } from "../smoke/font-assets-check.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const official = createRequire(resolve("packages/butler-app/client/ui/package.json"))
  .resolve("pretendard/dist/web/variable/woff2/PretendardVariable.woff2");
const PRETENDARD = "PretendardVariable-a1.woff2";
const FACE = `@font-face{font-family:"Pretendard Variable";font-weight:45 920;font-style:normal;font-display:swap;src:url(./${PRETENDARD}) format("woff2-variations")}`;

function fixture(options: { pretendard?: "official" | "modified" | "none"; face?: string; slices?: number; css?: string; notices?: string | null } = {}): string {
  const dist = mkdtempSync(join(tmpdir(), "font-assets-"));
  dirs.push(dist);
  mkdirSync(join(dist, "assets"));
  const refs: string[] = [];
  const pretendard = options.pretendard ?? "official";
  if (pretendard === "official") copyFileSync(official, join(dist, "assets", PRETENDARD));
  if (pretendard === "modified") writeFileSync(join(dist, "assets", PRETENDARD), Buffer.alloc(100));
  if (pretendard !== "none") refs.push(options.face ?? FACE);
  for (let index = 0; index < (options.slices ?? 0); index += 1) {
    const name = `PretendardVariable.subset.${index}-a${index}.woff2`;
    writeFileSync(join(dist, "assets", name), Buffer.alloc(100));
    refs.push(`@font-face{font-family:"Pretendard Variable";src:url(./${name}) format("woff2-variations");unicode-range:U+AC00-AC0F}`);
  }
  for (const face of ["Regular-Latin1", "SemiBold-Latin1"]) {
    const name = `IBMPlexMono-${face}-b1.woff2`;
    writeFileSync(join(dist, "assets", name), Buffer.alloc(10));
    refs.push(`@font-face{font-family:"IBM Plex Mono";src:url(./${name}) format("woff2")}`);
  }
  writeFileSync(join(dist, "assets", "index-c1.css"), options.css ?? refs.join(""));
  if (options.notices !== null) {
    writeFileSync(join(dist, "THIRD_PARTY_NOTICES.txt"), options.notices ?? "Pretendard\nIBM Plex Mono\nSIL OPEN FONT LICENSE Version 1.1\n");
  }
  return dist;
}

test("a complete build passes with the one official Pretendard face", () => {
  const report = inspectFontAssets(fixture());
  expect(report.ok).toBe(true);
  expect(report.pretendardFiles).toBe(1);
  expect(report.pretendardOfficial).toBe(true);
  expect(report.pretendardFace).toBe(true);
  expect(report.pretendardBytes).toBe(statSync(official).size);
  expect(report.pretendardSlices).toBe(0);
  expect(report.plexFiles).toBe(2);
  expect(report.plexBytes).toBe(20);
  expect(report.missing).toEqual([]);
  expect(report.external).toEqual([]);
});

test("a CSS url() without an emitted file fails", () => {
  const report = inspectFontAssets(fixture({ css: "@font-face{src:url(./Gone-x.woff2)}" }));
  expect(report.ok).toBe(false);
  expect(report.missing).toEqual(["assets/Gone-x.woff2"]);
});

test("a third-party font host fails", () => {
  const dist = fixture();
  writeFileSync(join(dist, "assets", "cdn-d1.css"), "@font-face{src:url(https://cdn.example.com/f.woff2)}");
  const report = inspectFontAssets(dist);
  expect(report.ok).toBe(false);
  expect(report.external).toEqual(["https://cdn.example.com/f.woff2"]);
});

test("a missing, modified or sliced Pretendard fails", () => {
  expect(inspectFontAssets(fixture({ pretendard: "none" })).ok).toBe(false);
  expect(inspectFontAssets(fixture({ pretendard: "modified" })).pretendardOfficial).toBe(false);
  expect(inspectFontAssets(fixture({ pretendard: "modified" })).ok).toBe(false);
  expect(inspectFontAssets(fixture({ slices: 3 })).ok).toBe(false);
});

test("the Pretendard face keeps every weight, swap and no unicode-range", () => {
  for (const face of [
    FACE.replace("45 920", "400"),
    FACE.replace("font-display:swap;", ""),
    FACE.replace("}", ";unicode-range:U+0000-00FF}"),
  ]) expect(inspectFontAssets(fixture({ face })).pretendardFace).toBe(false);
});

test("missing license notices fail", () => {
  expect(inspectFontAssets(fixture({ notices: null })).ok).toBe(false);
  expect(inspectFontAssets(fixture({ notices: "Pretendard only" })).ok).toBe(false);
});

test("root-absolute url()s resolve against the build base", () => {
  const dist = fixture();
  writeFileSync(join(dist, "assets", "sub-e1.css"), "@font-face{src:url(/ds/assets/IBMPlexMono-Regular-Latin1-b1.woff2)}");
  expect(inspectFontAssets(dist, "/ds/").ok).toBe(true);
  expect(inspectFontAssets(dist, "/").missing).toEqual(["ds/assets/IBMPlexMono-Regular-Latin1-b1.woff2"]);
});
