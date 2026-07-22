import { expect, test } from "bun:test";
import { readRepoOrLedgerFile, repoOrLedgerExists } from "../support/project-ledger-root.ts";

const retiredToolRuntimeSpecs = [
  {
    id: "SPEC-TOOL-RUNTIME-PROGRESSIVE-SURFACE",
    path: "project-ledger/projects/butler/specs/tool-runtime/progressive-tool-surface.md",
    replacement: "adaptive BTCC algorithm, phase contract, Turn state contract",
    boundary: "Cannot authorize new BTCC lifecycle",
  },
  {
    id: "SPEC-TOOL-RUNTIME-EVIDENCE-CAPABILITY-LEDGER",
    path: "project-ledger/projects/butler/specs/tool-runtime/evidence-capability-ledger.md",
    replacement: "SPEC-BTCC-PHASE-ORCHESTRATOR",
    boundary: "no longer target behavioral authority",
  },
  {
    id: "SPEC-TOOL-RUNTIME-RECOVERABLE-DELIVERY-STATE",
    path: "project-ledger/projects/butler/specs/tool-runtime/recoverable-delivery-state.md",
    replacement: "adaptive BTCC algorithm, phase contract, Turn state contract",
    boundary: "Cannot authorize new BTCC lifecycle",
  },
];

test("retired tool-runtime specs cannot regain BTCC authority", () => {
  for (const spec of retiredToolRuntimeSpecs) {
    expect(repoOrLedgerExists(spec.path)).toBe(true);
    const text = readRepoOrLedgerFile(spec.path);
    expect(text).toContain(spec.id);
    expect(text).toContain('status: "superseded"');
    expect(text).toContain(spec.replacement);
    expect(text).toContain(spec.boundary);
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

test("intent, search, and discovery defer semantic authority to BTCC", () => {
  const intent = readRepoOrLedgerFile("project-ledger/projects/butler/specs/model-owned-intent-decisions.md");
  expect(intent).toContain('status: "superseded"');
  expect(intent).toMatch(/exclusively own routing, Work binding, and\s+continuation/);
  expect(intent).toContain("MOI-SC07");

  const webSearch = readRepoOrLedgerFile("project-ledger/projects/butler/specs/web-search-tool.md");
  expect(webSearch).toContain("already selected model chooses these as ordinary operations");
  expect(webSearch).toContain("Runtime must not infer those decisions from regexes, keywords");
  expect(webSearch).toMatch(/language-specific\s+keyword detector/);
  expect(webSearch).toContain("selected model chooses authorized");

  const discovery = readRepoOrLedgerFile(
    "project-ledger/projects/butler/specs/agentic-core-tool-capability-discovery.md",
  );
  expect(discovery).toContain("Discovery alone is never same-turn activation");
  expect(discovery).toContain("concrete effect permits come only from accepted BTCC authority");
  expect(discovery).toContain("AC6-SC12");
});
