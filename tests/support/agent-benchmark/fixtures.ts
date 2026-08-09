import { createHash } from "node:crypto";
import type {
  BenchmarkFixture,
  BenchmarkFixtureSummary,
  BenchmarkScenario,
} from "./contracts.ts";

const FIXTURE_VERSION = "2026-08-09.2";

/** The checked-in corpus is intentionally small and reviewable. */
export const AGENT_BENCHMARK_FIXTURES: readonly BenchmarkFixture[] = [
  {
    id: "direct_conversation",
    version: FIXTURE_VERSION,
    prompts: [
      "Turn 1/4: Explain in two concise sentences what makes a benchmark reproducible.",
      "Turn 2/4: Give one concrete example of a confounding variable in an agent comparison.",
      "Turn 3/4: Correction: the comparison must include unavailable tools as gates, not zeros. Restate the metric rule.",
      "Turn 4/4: Synthesize the protocol in four bullets, preserving the correction and keeping the wording user-facing.",
    ],
    expectedClaims: [
      "reproducibility pins and records inputs and environment",
      "confounding variables are controlled in the comparison",
      "unavailable tools are gates or unknown rather than zeros",
    ],
  },
  {
    id: "current_web_research",
    version: FIXTURE_VERSION,
    frozenEvaluationDate: "2026-08-09",
    prompts: [
      "As of 2026-08-09, research the current stable Bun release and summarize the release date, the official release URL, and one primary-source change. Cite the official Bun release or documentation page for every factual claim. Distinguish the publication date from any date mentioned in the release notes. Search-result snippets are not sources.",
    ],
    expectedClaims: [
      "Bun v1.3.14 is the stable release under evaluation",
      "the release was published on May 13 2026",
      "the release includes built-in Bun.Image",
      "the answer distinguishes publication date from event date",
    ],
    authoritativeSourceClasses: ["official GitHub release", "official Bun blog"],
    expectedSources: [
      "https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14",
      "https://bun.com/blog/bun-v1.3.14",
    ],
  },
  {
    id: "butler_landing_page",
    version: FIXTURE_VERSION,
    prompts: [
      "Read the pinned Butler repository as evidence and create a project-introduction landing page in the empty output workspace only. Do not modify the source checkout. Include a responsive index.html, styles.css, README.md, and a minimal package.json with the declared build/test scripts. Accurately explain that Butler is a local-first assistant with an agent runtime, a desktop app, and durable project/work tracking; cite repository-relative evidence in README.md. Run the declared build/test commands, and leave the output ready for a desktop and mobile render.",
    ],
    expectedFiles: ["index.html", "styles.css", "README.md", "package.json"],
    expectedClaims: [
      "Butler is a local-first assistant",
      "Butler has an agent runtime and desktop app",
      "Butler tracks durable project or work state",
    ],
    requiredBuildCommand: ["npm", "run", "build"],
    requiredTestCommand: ["npm", "run", "test"],
    viewportSizes: [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ],
  },
] as const;

export function getBenchmarkFixture(id: BenchmarkScenario): BenchmarkFixture {
  const fixture = AGENT_BENCHMARK_FIXTURES.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Unknown agent benchmark fixture: ${id}`);
  return fixture;
}

export function materializeFixturePrompt(fixture: BenchmarkFixture): string {
  return fixture.prompts.join("\n\n");
}

export function hashBenchmarkFixture(fixture: BenchmarkFixture): string {
  return createHash("sha256").update(canonicalFixture(fixture)).digest("hex");
}

export function summarizeBenchmarkFixture(
  fixture: BenchmarkFixture,
): BenchmarkFixtureSummary {
  return {
    id: fixture.id,
    version: fixture.version,
    ...(fixture.frozenEvaluationDate ? { frozenEvaluationDate: fixture.frozenEvaluationDate } : {}),
    sha256: hashBenchmarkFixture(fixture),
    promptCount: fixture.prompts.length,
  };
}

function canonicalFixture(fixture: BenchmarkFixture): string {
  return JSON.stringify({
    id: fixture.id,
    version: fixture.version,
    frozenEvaluationDate: fixture.frozenEvaluationDate ?? null,
    prompts: fixture.prompts,
    expectedFiles: fixture.expectedFiles ?? [],
    expectedClaims: fixture.expectedClaims ?? [],
    expectedSources: fixture.expectedSources ?? [],
    authoritativeSourceClasses: fixture.authoritativeSourceClasses ?? [],
    requiredBuildCommand: fixture.requiredBuildCommand ?? [],
    requiredTestCommand: fixture.requiredTestCommand ?? [],
    viewportSizes: fixture.viewportSizes ?? [],
  });
}
