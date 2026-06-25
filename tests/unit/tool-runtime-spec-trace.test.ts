import { expect, test } from "bun:test";
import { readRepoOrLedgerFile, repoOrLedgerExists } from "../support/project-ledger-root.ts";

const toolRuntimeSpecs = [
  {
    id: "SPEC-TOOL-RUNTIME-PROGRESSIVE-SURFACE",
    path: "project-ledger/projects/butler/specs/tool-runtime/progressive-tool-surface.md",
    criteria: ["PTS-SC01", "PTS-SC05", "PTS-SC09"],
    requiredSections: ["## Bridge Tools", "## State Machine", "## Failure Semantics"],
  },
  {
    id: "SPEC-TOOL-RUNTIME-EVIDENCE-CAPABILITY-LEDGER",
    path: "project-ledger/projects/butler/specs/tool-runtime/evidence-capability-ledger.md",
    criteria: ["ECL-SC01", "ECL-SC04", "ECL-SC10", "ECL-SC12"],
    requiredSections: ["## Terminology Boundary", "## Evidence Contracts", "## Ledger State Machine", "## Satisfaction Rules"],
  },
  {
    id: "SPEC-TOOL-RUNTIME-RECOVERABLE-DELIVERY-STATE",
    path: "project-ledger/projects/butler/specs/tool-runtime/recoverable-delivery-state.md",
    criteria: ["RDS-SC01", "RDS-SC04", "RDS-SC07", "RDS-SC11", "RDS-SC12", "RDS-SC13"],
    requiredSections: ["## Delivery States", "## Recovery Loop", "## Error Classification"],
  },
];

test("tool runtime specs exist as dedicated implementable feature specs", () => {
  for (const spec of toolRuntimeSpecs) {
    expect(repoOrLedgerExists(spec.path)).toBe(true);
    const text = readRepoOrLedgerFile(spec.path);

    expect(text).toContain(spec.id);
    expect(text).toContain("## Source Of Truth");
    expect(text).toContain("## Product Goal");
    expect(text).toContain("## Ownership");
    expect(text).toContain("## Success Criteria");
    expect(text).toContain("## Trace Tests");

    for (const section of spec.requiredSections) {
      expect(text).toContain(section);
    }
    for (const criterion of spec.criteria) {
      expect(text).toContain(criterion);
    }
  }
});

test("tool runtime specs reserve Artifact for app-visible deliverables", () => {
  const evidence = readRepoOrLedgerFile("project-ledger/projects/butler/specs/tool-runtime/evidence-capability-ledger.md");
  expect(evidence).toContain("`Artifact` is reserved for app-visible user deliverables");
  expect(evidence).toContain("`durable outcome`");
  expect(evidence).toContain("`outcome reference`");
  expect(evidence).toContain("`evidence receipt`");
  expect(evidence).toContain("legacy internal schema names");
});

test("existing intent and search specs route tool activation through progressive disclosure", () => {
  const intent = readRepoOrLedgerFile("project-ledger/projects/butler/specs/model-owned-intent-decisions.md");
  expect(intent).toContain("model-selected progressive discovery");
  expect(intent).toContain("MOI-SC07");

  const webSearch = readRepoOrLedgerFile("project-ledger/projects/butler/specs/web-search-tool.md");
  expect(webSearch).toContain("progressive tool discovery");
  expect(webSearch).toContain("must not regex-match words");
  expect(webSearch).toMatch(/language-specific\s+keyword detector/);
  expect(webSearch).toContain("delivered with");

  const discovery = readRepoOrLedgerFile(
    "project-ledger/projects/butler/specs/agentic-core-tool-capability-discovery.md",
  );
  expect(discovery).toContain("Discovery alone is not same-turn activation");
  expect(discovery).toContain("AC6-SC12");
});
