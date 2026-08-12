import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readElectronScenario } from
  "../e2e/btcc-r3-electron/scenario-preflight.ts";

const ROOT = process.cwd();

describe("M1 v2 benchmark authority cleanup", () => {
  test("keeps no parallel baseline tree, import, or package runner alias", () => {
    expect(existsSync(join(ROOT, "tests/support/m1-v2-baseline"))).toBe(false);
    const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["benchmark:m1-v2-segment-attribution"]).toBeUndefined();
    expect(packageJson.scripts?.["benchmark:m1-v2-provenance"]).toBeUndefined();

    const imports = sourceFiles(join(ROOT, "tests"))
      .filter((path) => !path.endsWith("m1-v2-benchmark-authority.test.ts"))
      .filter((path) => /(?:from\s+|import\s*\()[^\n]*m1-v2-baseline/u.test(
        readFileSync(path, "utf8"),
      ));
    expect(imports).toEqual([]);
  });

  test("retains one typed SC01 smoke composed through the real Electron driver", () => {
    const scenarioPath = join(
      ROOT,
      "tests/support/m1-v2-segment-attribution-smoke.json",
    );
    const scenario = readElectronScenario(scenarioPath);
    expect(scenario).toMatchObject({
      id: "m1-v2-segment-attribution-direct-smoke",
      attributionArmId: "direct-smoke",
      cacheBoundaryEvidence: {
        expectedRevision: "m1-smoke-v2",
        observedRevision: "m1-smoke-v2",
      },
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "medium",
    });
    const driver = readFileSync(
      join(ROOT, "tests/e2e/btcc-r3-electron-driver.ts"),
      "utf8",
    );
    expect(driver).toContain("runBtccR3ElectronHarness(scenario, options)");
  });

  test("points benchmark execution and historical interpretation to PR 142", () => {
    const report = readFileSync(
      join(ROOT, "reports/report-m1-context-efficiency.md"),
      "utf8",
    );
    expect(report).toContain("PR #142");
    expect(report).toContain("sole fixture, provenance, campaign");
    expect(report).toContain("9 accepted / 3 rejected / 0 gated");
    expect(report).toContain("3 accepted / 0 rejected / 1 gated");
    expect(report).toMatch(/8\s+unscheduled/u);
    expect(report).toMatch(/all 12 observations remain rejected and\s+unranked/u);
  });
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name) ? [path] : [];
  });
}
