import { expect, test } from "bun:test";
import { readRepoOrLedgerFile, repoOrLedgerExists } from "../support/project-ledger-root.ts";

test("context management has a dedicated governing spec and phased plan", () => {
  const specPath = ".project-ledger/specs/context-management-optimization.md";
  const planPath = ".project-ledger/plans/plan-context-management-optimization.md";

  expect(repoOrLedgerExists(specPath)).toBe(true);
  expect(repoOrLedgerExists(planPath)).toBe(true);

  const spec = readRepoOrLedgerFile(specPath);
  const plan = readRepoOrLedgerFile(planPath);

  expect(spec).toContain("source of truth");
  expect(spec).toContain("Memory-Backed Context Contract");
  expect(spec).toContain("Auto Compaction Contract");
  expect(spec).toContain("Prompt Cache Strategy");

  for (let index = 1; index <= 10; index += 1) {
    expect(spec).toContain(`CM-SC${String(index).padStart(2, "0")}`);
  }

  for (let index = 0; index <= 6; index += 1) {
    expect(plan).toContain(`Phase CM-${index}`);
  }
});

test("context management research records RTK decision and cache policy", () => {
  const reportPath = ".project-ledger/reports/context-management-research.md";

  expect(repoOrLedgerExists(reportPath)).toBe(true);

  const report = readRepoOrLedgerFile(reportPath);

  expect(report).toContain("Do not make RTK default");
  expect(report).toContain("optional, config-gated, fail-open, shell-output-only adapter");
  expect(report).toContain("raw artifact handle");
  expect(report).toContain("license metadata mismatch");

  expect(report).toContain("70% used as warning");
  expect(report).toContain("80% used as auto-compaction trigger");
  expect(report).toContain("90% used as hard-pressure gate");
  expect(report).toContain("Compaction must handle overflow by chunking");
  expect(report).toContain("Compaction must lock per session");
  expect(report).toContain("summaries are cues, not replacement evidence");

  expect(report).toContain("stable product instructions and deterministic tool schemas in the prefix");
  expect(report).toContain("Track cache hit ratio by scope and model");
  expect(report).toContain("artifact retention");
});

test("context management research cites external memory and provider references", () => {
  const spec = readRepoOrLedgerFile(".project-ledger/specs/context-management-optimization.md");
  const report = readRepoOrLedgerFile(".project-ledger/reports/context-management-research.md");
  const combined = `${spec}\n${report}`;

  for (const url of [
    "https://arxiv.org/abs/2310.08560",
    "https://arxiv.org/abs/2304.03442",
    "https://arxiv.org/abs/2404.16130",
    "https://arxiv.org/abs/2405.14831",
    "https://arxiv.org/abs/2410.05779",
    "https://arxiv.org/abs/2409.05591",
    "https://arxiv.org/abs/2502.12110",
    "https://developers.openai.com/api/docs/guides/prompt-caching",
    "https://developers.openai.com/api/docs/guides/compaction",
    "https://github.com/rtk-ai/rtk",
  ]) {
    expect(combined).toContain(url);
  }
});
