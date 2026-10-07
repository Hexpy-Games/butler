// Build-output check for the bundled UI fonts (DS spec Typeface Contract):
// every font url() in the emitted CSS resolves to an emitted file, no font is
// loaded from a third-party host, the official single-file Pretendard Variable
// face (byte-identical to the pinned package, full Hangul coverage, weights
// 45-920) and the IBM Plex Mono files ship, no unicode-range slices of
// Pretendard remain, and the OFL notices sit next to index.html.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix, resolve } from "node:path";

export interface FontAssetsReport {
  ok: boolean;
  pretendardFiles: number;
  pretendardBytes: number;
  pretendardOfficial: boolean;
  pretendardFace: boolean;
  pretendardSlices: number;
  plexFiles: number;
  plexBytes: number;
  missing: string[];
  external: string[];
  notices: boolean;
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The pinned official file the UI package resolves (packages/butler-app/client/ui). */
function officialPretendard(): string {
  const require = createRequire(resolve(process.cwd(), "packages/butler-app/client/ui/package.json"));
  return require.resolve("pretendard/dist/web/variable/woff2/PretendardVariable.woff2");
}

/** `base` is the build's public base; root-absolute url()s resolve against it. */
export function inspectFontAssets(distDir: string, base = "/"): FontAssetsReport {
  const assets = readdirSync(join(distDir, "assets"));
  const size = (name: string) => statSync(join(distDir, "assets", name)).size;
  const pretendard = assets.filter((name) => /^PretendardVariable-[\w-]+\.woff2$/u.test(name));
  const slices = assets.filter((name) => /^PretendardVariable\.subset\./u.test(name));
  const plex = assets.filter((name) => /^IBMPlexMono-[\w-]+\.woff2$/u.test(name));
  const official = sha256(officialPretendard());
  const missing: string[] = [];
  const external: string[] = [];
  let pretendardFaces = 0, pretendardFaceValid = true;
  for (const css of assets.filter((name) => name.endsWith(".css"))) {
    const text = readFileSync(join(distDir, "assets", css), "utf8");
    for (const [, raw] of text.matchAll(/url\(\s*["']?([^"')]+\.woff2?)["']?\s*\)/gu)) {
      const ref = raw!.trim();
      if (/^[a-z]+:/iu.test(ref) || ref.startsWith("//")) {
        external.push(ref);
        continue;
      }
      const path = ref.startsWith("/")
        ? (ref.startsWith(base) ? posix.normalize(ref.slice(base.length)) : ref)
        : posix.normalize(posix.join("assets", ref));
      if (!existsSync(join(distDir, path))) missing.push(path);
    }
    // One face for every script and weight: no unicode-range, so Hangul never splits into per-slice runs.
    for (const [, face] of text.matchAll(/@font-face\s*\{([^}]*)\}/gu)) {
      if (!/font-family:\s*["']?Pretendard Variable/u.test(face!)) continue;
      pretendardFaces += 1;
      pretendardFaceValid &&= /font-weight:\s*45 920/u.test(face!) && /font-display:\s*swap/u.test(face!)
        && !/unicode-range/u.test(face!) && /PretendardVariable-[\w-]+\.woff2/u.test(face!);
    }
  }
  const pretendardFace = pretendardFaces > 0 && pretendardFaceValid;
  const pretendardOfficial = pretendard.length === 1 && sha256(join(distDir, "assets", pretendard[0]!)) === official;
  const noticesPath = join(distDir, "THIRD_PARTY_NOTICES.txt");
  const noticesText = existsSync(noticesPath) ? readFileSync(noticesPath, "utf8") : "";
  const notices = ["Pretendard", "IBM Plex Mono", "SIL OPEN FONT LICENSE Version 1.1"]
    .every((needle) => noticesText.includes(needle));
  return {
    ok: pretendardOfficial && pretendardFace && slices.length === 0 && plex.length > 0
      && missing.length === 0 && external.length === 0 && notices,
    pretendardFiles: pretendard.length,
    pretendardBytes: pretendard.reduce((total, name) => total + size(name), 0),
    pretendardOfficial,
    pretendardFace,
    pretendardSlices: slices.length,
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
  const report = inspectFontAssets(distDir, process.env.DS_SITE_BASE ?? "/");
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) throw new Error("Bundled font assets are incomplete; see the report above.");
}
