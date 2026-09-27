// Build-output check for the bundled UI fonts (DS spec Typeface Contract):
// every font url() in the emitted CSS resolves to an emitted file, no font is
// loaded from a third-party host, all official Pretendard Variable slices and
// the IBM Plex Mono files ship, and the OFL notices sit next to index.html.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";

export const PRETENDARD_SLICE_COUNT = 92;

export interface FontAssetsReport {
  ok: boolean;
  pretendardSlices: number;
  pretendardBytes: number;
  plexFiles: number;
  plexBytes: number;
  missing: string[];
  external: string[];
  notices: boolean;
}

export function inspectFontAssets(distDir: string): FontAssetsReport {
  const assets = readdirSync(join(distDir, "assets"));
  const size = (name: string) => statSync(join(distDir, "assets", name)).size;
  const slices = assets.filter((name) => /^PretendardVariable\.subset\.\d+-[\w-]+\.woff2$/u.test(name));
  const plex = assets.filter((name) => /^IBMPlexMono-[\w-]+\.woff2$/u.test(name));
  const missing: string[] = [];
  const external: string[] = [];
  for (const css of assets.filter((name) => name.endsWith(".css"))) {
    const text = readFileSync(join(distDir, "assets", css), "utf8");
    for (const [, raw] of text.matchAll(/url\(\s*["']?([^"')]+\.woff2?)["']?\s*\)/gu)) {
      const ref = raw!.trim();
      if (/^[a-z]+:/iu.test(ref) || ref.startsWith("//")) {
        external.push(ref);
        continue;
      }
      const path = posix.normalize(posix.join("assets", ref));
      if (!existsSync(join(distDir, path))) missing.push(path);
    }
  }
  const noticesPath = join(distDir, "THIRD_PARTY_NOTICES.txt");
  const noticesText = existsSync(noticesPath) ? readFileSync(noticesPath, "utf8") : "";
  const notices = ["Pretendard", "IBM Plex Mono", "SIL OPEN FONT LICENSE Version 1.1"]
    .every((needle) => noticesText.includes(needle));
  return {
    ok: slices.length === PRETENDARD_SLICE_COUNT && plex.length > 0
      && missing.length === 0 && external.length === 0 && notices,
    pretendardSlices: slices.length,
    pretendardBytes: slices.reduce((total, name) => total + size(name), 0),
    plexFiles: plex.length,
    plexBytes: plex.reduce((total, name) => total + size(name), 0),
    missing,
    external,
    notices,
  };
}

if (import.meta.main) {
  // Default: the app UI build; pass a dist path for another build (the DS site).
  const distDir = resolve(process.argv[2] ?? resolve(process.cwd(), "packages", "butler-app", "client", "ui", "dist"));
  if (!existsSync(join(distDir, "index.html"))) {
    throw new Error("UI dist is missing. Run `npm --prefix packages/butler-app/client/ui run build` first.");
  }
  const report = inspectFontAssets(distDir);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) throw new Error("Bundled font assets are incomplete; see the report above.");
}
