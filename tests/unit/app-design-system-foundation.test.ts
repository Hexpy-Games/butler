import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoOrLedgerPath } from "../support/project-ledger-root.ts";

const root = process.cwd();
const uiSrc = "packages/butler-app/client/ui/src";

function read(path: string): string {
  return readFileSync(resolveRepoOrLedgerPath(path), "utf8");
}

describe("design-system foundation spec", () => {
  test("spec records the Phase 1 foundation contracts", () => {
    const spec = read(
      "project-ledger/projects/butler/specs/butler-dedicated-client-design-system.md",
    );
    for (const heading of [
      "## Scroll Fade Contract",
      "## Tinted Glass Contract",
      "## Theme Parity Contract",
      "## Focus Ring Contract",
      "## Layering Contract",
      "## Control And Menu Sizing Contract",
      "## Locale And Korean Typography Contract",
    ]) {
      expect(spec).toContain(heading);
    }
    expect(spec).toContain("--scroll-fade-size");
    expect(spec).toContain("--focus-ring");
    expect(spec).toContain("--menu-item-height");
    expect(spec).toContain("--z-tooltip");
  });
});

