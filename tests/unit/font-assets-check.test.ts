import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectFontAssets } from "../smoke/font-assets-check.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(options: { slices?: number; css?: string; notices?: string | null } = {}): string {
  const dist = mkdtempSync(join(tmpdir(), "font-assets-"));
  dirs.push(dist);
  mkdirSync(join(dist, "assets"));
  const slices = options.slices ?? 92;
  const refs: string[] = [];
  for (let index = 0; index < slices; index += 1) {
    const name = `PretendardVariable.subset.${index}-a${index}.woff2`;
    writeFileSync(join(dist, "assets", name), Buffer.alloc(100));
    refs.push(`@font-face{font-family:"Pretendard Variable";src:url(./${name}) format("woff2-variations")}`);
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

test("a complete build passes and reports slice sizes", () => {
  const report = inspectFontAssets(fixture());
  expect(report.ok).toBe(true);
  expect(report.pretendardSlices).toBe(92);
  expect(report.pretendardBytes).toBe(9200);
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

test("missing slices or license notices fail", () => {
  expect(inspectFontAssets(fixture({ slices: 10 })).ok).toBe(false);
  expect(inspectFontAssets(fixture({ notices: null })).ok).toBe(false);
  expect(inspectFontAssets(fixture({ notices: "Pretendard only" })).ok).toBe(false);
});

test("root-absolute url()s resolve against the build base", () => {
  const dist = fixture();
  writeFileSync(join(dist, "assets", "sub-e1.css"), "@font-face{src:url(/ds/assets/IBMPlexMono-Regular-Latin1-b1.woff2)}");
  expect(inspectFontAssets(dist, "/ds/").ok).toBe(true);
  expect(inspectFontAssets(dist, "/").missing).toEqual(["ds/assets/IBMPlexMono-Regular-Latin1-b1.woff2"]);
});
