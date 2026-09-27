import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Must match DS_VIEWER_BUNDLE_MARKER in libs/design-system/viewer/bundleMarker.ts.
export const DS_VIEWER_BUNDLE_MARKER = "butler-ds-viewer:lazy-chunk";

export interface DsViewerBundleReport {
  ok: boolean;
  eagerFiles: string[];
  eagerFilesWithMarker: string[];
  lazyFilesWithMarker: string[];
}

function eagerScriptPaths(indexHtml: string): string[] {
  const paths = [
    ...indexHtml.matchAll(/<script[^>]*\ssrc="([^"]+\.js)"/gu),
    ...indexHtml.matchAll(/<link[^>]*rel="modulepreload"[^>]*\shref="([^"]+\.js)"/gu),
  ].map((match) => match[1].replace(/^\.?\//u, ""));
  return [...new Set(paths)];
}

export function inspectDsViewerBundle(distDir: string): DsViewerBundleReport {
  const indexHtml = readFileSync(join(distDir, "index.html"), "utf8");
  const eagerFiles = eagerScriptPaths(indexHtml);
  const assetFiles = readdirSync(join(distDir, "assets"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `assets/${name}`)
    .sort();
  const hasMarker = (path: string) =>
    readFileSync(join(distDir, path), "utf8").includes(DS_VIEWER_BUNDLE_MARKER);
  const eagerFilesWithMarker = eagerFiles.filter(hasMarker);
  const lazyFilesWithMarker = assetFiles
    .filter((path) => !eagerFiles.includes(path))
    .filter(hasMarker);

  return {
    ok: eagerFiles.length > 0 && eagerFilesWithMarker.length === 0 && lazyFilesWithMarker.length > 0,
    eagerFiles,
    eagerFilesWithMarker,
    lazyFilesWithMarker,
  };
}

if (import.meta.main) {
  const distDir = resolve(process.cwd(), "packages", "butler-app", "client", "ui", "dist");
  if (!existsSync(join(distDir, "index.html"))) {
    throw new Error("UI dist is missing. Run `npm --prefix packages/butler-app/client/ui run build` first.");
  }
  const report = inspectDsViewerBundle(distDir);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    throw new Error(
      "DS Viewer must be lazy-loaded: the marker must appear only in a non-entry chunk.",
    );
  }
}
