import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const root = process.cwd();

const capabilitySpecs = [
  {
    id: "AC-1",
    spec: ".project-ledger/specs/agentic-core-todo-lists.md",
    legacySpec: "docs/specs/agentic-core-todo-lists.md",
    criteria: ["AC1-SC01", "AC1-SC06"],
    tests: ["tests/unit/todo-list.test.ts", "tests/unit/prompt-assembler.test.ts"],
  },
  {
    id: "AC-2",
    spec: ".project-ledger/specs/agentic-core-context-monitoring.md",
    legacySpec: "docs/specs/agentic-core-context-monitoring.md",
    criteria: ["AC2-SC01", "AC2-SC06"],
    tests: ["tests/unit/context-monitor.test.ts", "tests/unit/butler-tools.test.ts"],
  },
  {
    id: "AC-3",
    spec: ".project-ledger/specs/agentic-core-usage-monitoring.md",
    legacySpec: "docs/specs/agentic-core-usage-monitoring.md",
    criteria: ["AC3-SC01", "AC3-SC06"],
    tests: ["tests/unit/usage-monitor.test.ts", "tests/unit/butler-tools.test.ts"],
  },
  {
    id: "AC-4",
    spec: ".project-ledger/specs/agentic-core-automation.md",
    legacySpec: "docs/specs/agentic-core-automation.md",
    criteria: ["AC4-SC01", "AC4-SC06"],
    tests: ["tests/unit/automation-store.test.ts", "tests/unit/automation-gateway.test.ts"],
  },
  {
    id: "AC-5",
    spec: ".project-ledger/specs/agentic-core-mode-safety-controls.md",
    legacySpec: "docs/specs/agentic-core-mode-safety-controls.md",
    criteria: ["AC5-SC01", "AC5-SC06"],
    tests: ["tests/unit/planned-task-store.test.ts", "tests/unit/work-dashboard.test.ts"],
  },
  {
    id: "AC-6",
    spec: ".project-ledger/specs/agentic-core-tool-capability-discovery.md",
    legacySpec: "docs/specs/agentic-core-tool-capability-discovery.md",
    criteria: ["AC6-SC01", "AC6-SC06"],
    tests: ["tests/unit/butler-tools.test.ts", "tests/unit/native-tool-loop-runtime.test.ts"],
  },
  {
    id: "AC-7",
    spec: ".project-ledger/specs/agentic-core-work-orchestration.md",
    legacySpec: "docs/specs/agentic-core-work-orchestration.md",
    criteria: ["AC7-SC01", "AC7-SC06"],
    tests: ["tests/unit/work-orchestration.test.ts", "tests/unit/native-tool-loop-runtime.test.ts"],
  },
];

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("Agentic Core capabilities have dedicated governing specs", () => {
  const index = readRepoFile(".project-ledger/specs/agentic-core-capabilities.md");

  expect(index).toContain("index and trace hub");
  expect(index).toContain("no longer the governing behavior spec");

  for (const capability of capabilitySpecs) {
    expect(existsSync(join(root, capability.spec))).toBe(true);
    expect(index).toContain(capability.legacySpec);

    const spec = readRepoFile(capability.spec);
    expect(spec).toContain(`${capability.id}`);
    expect(spec).toContain("source of truth");
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
});

test("Agentic Core plan references the dedicated governing specs", () => {
  const plan = readRepoFile(".project-ledger/plans/plan-agentic-core-capabilities.md");

  for (const capability of capabilitySpecs) {
    expect(plan).toContain(capability.id);
    expect(plan).toContain(capability.legacySpec);
  }
});
