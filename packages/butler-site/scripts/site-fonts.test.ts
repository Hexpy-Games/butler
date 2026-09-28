import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_ROOT } from "./check-token-sync";

// The manual uses the app's bundled faces (DS spec Typeface Contract), not a copy.
test("base.css loads the app's bundled fonts.css, which exists", () => {
  const base = readFileSync(join(SITE_ROOT, "src", "ds", "base.css"), "utf8");
  const ref = /@import url\("([^"]*fonts\/fonts\.css)"\);/u.exec(base)?.[1];
  expect(ref).toBe("../../../butler-app/client/ui/src/libs/design-system/fonts/fonts.css");
  expect(existsSync(join(SITE_ROOT, "src", "ds", ref!))).toBe(true);
});

test("the site root ships the fonts' OFL notices", () => {
  expect(readFileSync(join(SITE_ROOT, "scripts", "build-ds.ts"), "utf8")).toContain("THIRD_PARTY_NOTICES.txt");
});
