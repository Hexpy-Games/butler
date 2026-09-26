import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareRatchet,
  ratchetFailures,
  shrinkBaseline,
} from "../../packages/butler-app/scripts/lint/butler-ds/ratchet.ts";
import {
  DS_CONSTRAINT_RULES,
  PRODUCT_EXCLUSIONS,
  baselineFileName,
  isProductSource,
} from "../../packages/butler-app/scripts/lint/butler-ds/scope.ts";

const root = process.cwd();

describe("DS constraint product scope", () => {
  test("product code is client/ui/src minus the design system, tests, fixtures and harness pages", () => {
    expect(isProductSource("components/conversation/Composer.tsx")).toBe(true);
    expect(isProductSource("components/space/SpaceSidebar.module.css")).toBe(true);
    expect(isProductSource("pages/AppShell.tsx")).toBe(true);
    expect(isProductSource("main.tsx")).toBe(true);
    expect(isProductSource("libs/design-system/components/Button/Button.tsx")).toBe(false);
    expect(isProductSource("components/command/CommandPalette.test.tsx")).toBe(false);
    expect(isProductSource("app/confirmation.test.ts")).toBe(false);
    expect(isProductSource("app/fixtures.ts")).toBe(false);
    expect(isProductSource("pages/VisualHarness.tsx")).toBe(false);
    expect(isProductSource("pages/ThinkingMarkHarness.module.css")).toBe(false);
    expect(isProductSource("vite-env.d.ts")).toBe(false);
  });

  test("the exclusion list stays explicit and minimal", () => {
    expect(PRODUCT_EXCLUSIONS.map((exclusion) => exclusion.pattern)).toEqual([
      "libs/design-system/**",
      "**/*.test.ts, **/*.test.tsx",
      "**/*.d.ts",
      "app/fixtures.ts",
      "pages/*Harness.tsx, pages/*Harness.module.css",
    ]);
  });
});

describe("DS constraint ratchet", () => {
  test("an unchanged count passes", () => {
    const result = compareRatchet({ "a.tsx": 2 }, { "a.tsx": 2 });
    expect(ratchetFailures("no-inline-style", result)).toEqual([]);
  });

  test("a grown count or a new file fails", () => {
    const result = compareRatchet({ "a.tsx": 2 }, { "a.tsx": 3, "b.tsx": 1 });
    expect(result.grown).toEqual([{ file: "a.tsx", baseline: 2, current: 3 }]);
    expect(result.added).toEqual([{ file: "b.tsx", current: 1 }]);
    const failures = ratchetFailures("no-inline-style", result);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("a.tsx");
    expect(failures[0]).toContain("2 -> 3");
    expect(failures[1]).toContain("b.tsx");
  });

  test("a shrunk or cleared count fails until the baseline is regenerated", () => {
    const result = compareRatchet({ "a.tsx": 2, "c.tsx": 1 }, { "a.tsx": 1 });
    expect(result.shrunk).toEqual([
      { file: "a.tsx", baseline: 2, current: 1 },
      { file: "c.tsx", baseline: 1, current: 0 },
    ]);
    const failures = ratchetFailures("no-inline-style", result);
    expect(failures).toHaveLength(2);
    expect(failures.join("\n")).toContain("bun run lint:ds:baseline");
  });

  test("baseline regeneration only shrinks unless growth is explicitly allowed", () => {
    const shrunk = shrinkBaseline({ "a.tsx": 2, "c.tsx": 1 }, { "a.tsx": 1, "b.tsx": 4 });
    expect(shrunk.next).toEqual({ "a.tsx": 1 });
    expect(shrunk.refused).toEqual(["b.tsx: 0 -> 4"]);
    const grown = shrinkBaseline({ "a.tsx": 2 }, { "a.tsx": 3 }, { allowGrowth: true });
    expect(grown.next).toEqual({ "a.tsx": 3 });
    expect(grown.refused).toEqual([]);
  });

  test("every rule has a checked-in baseline and new CSS modules are outside the frozen allowlist", () => {
    for (const rule of DS_CONSTRAINT_RULES) {
      const path = join(root, "packages/butler-app/scripts/lint/butler-ds/baseline", `${baselineFileName(rule)}.json`);
      expect(existsSync(path)).toBe(true);
    }
    // The UNSAFE_style allowlist is a per-file baseline named unsafe-style.json.
    expect(DS_CONSTRAINT_RULES).toContain("unsafe-style-allowlist");
    expect(baselineFileName("unsafe-style-allowlist")).toBe("unsafe-style");
    const allowlist = JSON.parse(readFileSync(join(root,
      "packages/butler-app/scripts/lint/butler-ds/baseline/no-new-css-module.json"), "utf8")) as Record<string, number>;
    const result = compareRatchet(allowlist, { ...allowlist, "components/new/New.module.css": 1 });
    expect(ratchetFailures("no-new-css-module", result)[0]).toContain("components/new/New.module.css");
  });
});
