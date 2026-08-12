import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { copyGeneratedArtifacts } from "../support/agent-benchmark/butler-output.ts";
import type { BenchmarkArmPlan, BenchmarkFixture } from "../support/agent-benchmark/contracts.ts";
import { AGENT_BENCHMARK_FIXTURES, loadM1V2BenchmarkFixtures } from "../support/agent-benchmark/fixtures.ts";

test("canonical M1 landing artifact copy preserves generated files and excludes runtime namespaces", () => {
  const fixture = loadM1V2BenchmarkFixtures(process.cwd())
    .find((candidate) => candidate.id === "landing-cold")!;
  withArtifactWorkspace(fixture, ({ arm, workspace }) => {
    const generated = {
      "index.html": "<main>canonical landing</main>",
      "styles.css": "main { display: grid; }",
      "package.json": '{"scripts":{"build":"true"}}',
    } as const;
    writeWorkspaceFiles(workspace, generated);
    writeWorkspaceFiles(workspace, {
      ".benchmark-input/repository/README.md": "excluded",
      "node_modules/dependency/index.js": "excluded",
      "dist/bundle.js": "excluded",
      "build/output.js": "excluded",
      "coverage/report.json": "excluded",
      ".cache/state.json": "excluded",
      ".next/server.js": "excluded",
      "out/export.html": "excluded",
    });

    copyGeneratedArtifacts({ run: { workspaceRoot: workspace } }, { arm, fixture });

    for (const [path, contents] of Object.entries(generated)) {
      expect(readFileSync(join(arm.outputRoot, path), "utf8")).toBe(contents);
    }
    for (const excludedRoot of [".benchmark-input", "node_modules", "dist", "build", "coverage", ".cache", ".next", "out"]) {
      expect(existsSync(join(arm.outputRoot, excludedRoot))).toBe(false);
    }
  });
});

test("artifact copy remains enabled for the legacy landing fixture", () => {
  const fixture = AGENT_BENCHMARK_FIXTURES.find((candidate) => candidate.id === "butler_landing_page")!;
  withArtifactWorkspace(fixture, ({ arm, workspace }) => {
    writeWorkspaceFiles(workspace, { "index.html": "legacy landing" });
    copyGeneratedArtifacts({ run: { workspaceRoot: workspace } }, { arm, fixture });
    expect(readFileSync(join(arm.outputRoot, "index.html"), "utf8")).toBe("legacy landing");
  });
});

test("artifact copy remains disabled for non-landing fixtures", () => {
  const fixture = loadM1V2BenchmarkFixtures(process.cwd())
    .find((candidate) => candidate.id === "direct-cold")!;
  withArtifactWorkspace(fixture, ({ arm, workspace }) => {
    writeWorkspaceFiles(workspace, { "answer.txt": "must not be copied" });
    copyGeneratedArtifacts({ run: { workspaceRoot: workspace } }, { arm, fixture });
    expect(existsSync(join(arm.outputRoot, "answer.txt"))).toBe(false);
  });
});

function withArtifactWorkspace(
  fixture: BenchmarkFixture,
  run: (input: { arm: BenchmarkArmPlan; workspace: string }) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-artifact-copy-"));
  try {
    run({ arm: benchmarkArm(join(root, "output"), fixture.id), workspace: join(root, "workspace") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeWorkspaceFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, contents, "utf8");
  }
}

function benchmarkArm(outputRoot: string, scenario: BenchmarkArmPlan["scenario"]): BenchmarkArmPlan {
  return {
    key: `butler:${scenario}`,
    scenario,
    repetition: 1,
    order: 1,
    agent: "butler",
    track: "controlled",
    cache: "cold",
    fixtureHash: "fixture-hash",
    effectiveConfig: {
      model: "openai/gpt-5.6-sol",
      reasoning: "medium",
      permissions: "fixture",
      tools: [],
      memoryEnabled: null,
      skillsEnabled: null,
      pluginsEnabled: null,
      mcpEnabled: null,
      provider: "openai",
      variant: null,
    },
    sourceRoot: process.cwd(),
    outputRoot,
    dataRoot: `${outputRoot}-data`,
    evidenceRoot: `${outputRoot}-evidence`,
    cacheRoot: `${outputRoot}-cache`,
    cachePairId: `pair:${scenario}`,
    timeoutMs: 1_000,
    sourceRevision: "fixture-revision",
  };
}
