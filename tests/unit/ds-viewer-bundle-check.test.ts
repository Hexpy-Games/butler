import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    DS_VIEWER_BUNDLE_MARKER,
    inspectDsViewerBundle,
} from "../smoke/ds-viewer-bundle-check.ts";

const tempDirs: string[] = [];

function fakeDist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "butler-ds-bundle-check-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "assets"), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const indexHtml = [
  "<!doctype html><html><head>",
  '<script type="module" crossorigin src="./assets/index-abc.js"></script>',
  '<link rel="modulepreload" crossorigin href="./assets/shared-def.js">',
  "</head><body><div id=\"root\"></div></body></html>",
].join("\n");

describe("DS Viewer bundle check", () => {
  test("passes when only a lazy chunk carries the viewer marker", () => {
    const dist = fakeDist({
      "index.html": indexHtml,
      "assets/index-abc.js": "import('./DesignSystemViewer-xyz.js')",
      "assets/shared-def.js": "export const shared = 1;",
      "assets/DesignSystemViewer-xyz.js": `const m = "${DS_VIEWER_BUNDLE_MARKER}";`,
    });

    const result = inspectDsViewerBundle(dist);

    expect(result.eagerFiles).toEqual(["assets/index-abc.js", "assets/shared-def.js"]);
    expect(result.eagerFilesWithMarker).toEqual([]);
    expect(result.lazyFilesWithMarker).toEqual(["assets/DesignSystemViewer-xyz.js"]);
    expect(result.ok).toBe(true);
  });

  test("fails when the main entry chunk contains the viewer marker", () => {
    const dist = fakeDist({
      "index.html": indexHtml,
      "assets/index-abc.js": `const m = "${DS_VIEWER_BUNDLE_MARKER}";`,
      "assets/shared-def.js": "export const shared = 1;",
    });

    const result = inspectDsViewerBundle(dist);

    expect(result.eagerFilesWithMarker).toEqual(["assets/index-abc.js"]);
    expect(result.ok).toBe(false);
  });

  test("fails when no chunk carries the marker, so the check cannot pass vacuously", () => {
    const dist = fakeDist({
      "index.html": indexHtml,
      "assets/index-abc.js": "console.log(1)",
      "assets/shared-def.js": "export const shared = 1;",
    });

    expect(inspectDsViewerBundle(dist).ok).toBe(false);
  });
});
