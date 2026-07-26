import { expect, test } from "bun:test";
import { readRepoOrLedgerFile, repoOrLedgerExists } from "../support/project-ledger-root.ts";

const dedicatedCapabilitySpecs = [
  {
    id: "AC-2",
    spec: "project-ledger/projects/butler/specs/agentic-core-context-monitoring.md",
    legacySpec: "docs/specs/agentic-core-context-monitoring.md",
    criteria: ["AC2-SC01", "AC2-SC06"],
    tests: ["tests/unit/context-monitor.test.ts", "tests/unit/butler-tools.test.ts"],
  },
  {
    id: "AC-3",
    spec: "project-ledger/projects/butler/specs/agentic-core-usage-monitoring.md",
    legacySpec: "docs/specs/agentic-core-usage-monitoring.md",
    criteria: ["AC3-SC01", "AC3-SC06"],
    tests: ["tests/unit/usage-monitor.test.ts", "tests/unit/butler-tools.test.ts"],
  },
  {
    id: "AC-4",
    spec: "project-ledger/projects/butler/specs/agentic-core-automation.md",
    legacySpec: "docs/specs/agentic-core-automation.md",
    criteria: ["AC4-SC01", "AC4-SC06"],
    tests: ["tests/unit/automation-store.test.ts", "tests/unit/btcc-product-cutover.test.ts"],
  },
  {
    id: "AC-5",
    spec: "project-ledger/projects/butler/specs/agentic-core-mode-safety-controls.md",
    legacySpec: "docs/specs/agentic-core-mode-safety-controls.md",
    criteria: ["AC5-SC01", "AC5-SC06"],
    tests: ["tests/unit/planned-task-store.test.ts", "tests/unit/work-dashboard.test.ts"],
  },
  {
    id: "AC-6",
    spec: "project-ledger/projects/butler/specs/agentic-core-tool-capability-discovery.md",
    legacySpec: "docs/specs/agentic-core-tool-capability-discovery.md",
    criteria: ["AC6-SC01", "AC6-SC06"],
    tests: ["tests/unit/butler-tools.test.ts", "tests/unit/native-tool-loop-runtime.test.ts"],
  },
];

const btccSubordinateCapabilities = [
  {
    id: "AC-1",
    spec: "project-ledger/projects/butler/specs/spec-btcc-event-and-projection-contract.md",
    governingId: "SPEC-BTCC-EVENT-AND-PROJECTION-CONTRACT",
  },
  {
    id: "AC-7",
    spec: "project-ledger/projects/butler/specs/spec-btcc-domain-module-architecture.md",
    governingId: "SPEC-BTCC-DOMAIN-MODULE-ARCHITECTURE",
  },
];

test("Agentic Core capabilities resolve to current governing specs", () => {
  const index = readRepoOrLedgerFile("project-ledger/projects/butler/specs/agentic-core-capabilities.md");

  expect(index).toContain("index and trace hub");
  expect(index).toContain("no longer the governing behavior spec");

  for (const capability of dedicatedCapabilitySpecs) {
    expect(repoOrLedgerExists(capability.spec)).toBe(true);
    expect(index).toContain(capability.legacySpec);

    const spec = readRepoOrLedgerFile(capability.spec);
    expect(spec).toContain(`${capability.id}`);
    expect(spec).toMatch(/source of truth|owns .* only/);
    expect(spec).toContain("## Required Behavior");
    expect(spec).toContain("## Success Criteria");
    expect(spec).toContain("## Trace Tests");

    for (const criterion of capability.criteria) {
      expect(spec).toContain(criterion);
    }
    for (const traceTest of capability.tests) {
      expect(spec).toContain(traceTest);
    }
  }

  for (const capability of btccSubordinateCapabilities) {
    expect(repoOrLedgerExists(capability.spec)).toBe(true);
    expect(index).toContain(`| ${capability.id} |`);
    expect(index).toContain(capability.governingId);
    expect(readRepoOrLedgerFile(capability.spec)).toContain(capability.governingId);
  }
});

test("Agentic Core plan references the dedicated governing specs", () => {
  const plan = readRepoOrLedgerFile(
    "project-ledger/projects/butler/plans/plan-agentic-core-capabilities.md",
  );

  for (const capability of dedicatedCapabilitySpecs) {
    expect(plan).toContain(capability.id);
    expect(plan).toContain(capability.legacySpec);
  }
});
