import { expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { readRepoOrLedgerFile, repoOrLedgerExists } from "../support/project-ledger-root.ts";

const conversationCoreSpecs = [
  {
    id: "SPEC-GATEWAY-NEUTRAL-CONVERSATION-CORE",
    path: "project-ledger/projects/butler/specs/spec-gateway-neutral-conversation-core.md",
    criteria: ["GNCC-SC01", "GNCC-SC04"],
    sections: ["## Source Of Truth", "## Spec Family", "## Boundary Rules", "## Review Criteria"],
  },
  {
    id: "SPEC-AGENT-CONVERSATION-STORE",
    path: "project-ledger/projects/butler/specs/spec-agent-conversation-store.md",
    criteria: ["ACS-SC01", "ACS-SC07"],
    sections: ["## Source Of Truth", "## Runtime Owner", "## Canonical Entities", "## Validation Shape"],
  },
  {
    id: "SPEC-CONVERSATION-ADMISSION-AUDIT-BOUNDARY",
    path: "project-ledger/projects/butler/specs/spec-conversation-admission-audit-boundary.md",
    criteria: ["CAA-SC01", "CAA-SC07"],
    sections: ["## Source Of Truth", "## Semantic Allowlist", "## Deny By Default", "## Validation Shape"],
  },
  {
    id: "SPEC-GATEWAY-CONVERSATION-PROJECTIONS",
    path: "project-ledger/projects/butler/specs/spec-gateway-conversation-projections.md",
    criteria: ["GCP-SC01", "GCP-SC07"],
    sections: ["## Source Of Truth", "## Projection Outbox", "## App Gateway Projection", "## Validation Shape"],
  },
  {
    id: "SPEC-CONVERSATION-CONTEXT-COMPACTION",
    path: "project-ledger/projects/butler/specs/spec-conversation-context-compaction.md",
    criteria: ["CCC-SC01", "CCC-SC07"],
    sections: ["## Source Of Truth", "## Prompt Material Contract", "## Compaction Algorithm", "## Validation Shape"],
  },
  {
    id: "SPEC-COGNITION-CONVERSATION-SOURCES",
    path: "project-ledger/projects/butler/specs/spec-cognition-conversation-sources.md",
    criteria: ["CCS-SC01", "CCS-SC07"],
    sections: ["## Source Of Truth", "## Conversation Observation Shape", "## Working Memory", "## Validation Shape"],
  },
];

const implementationTasks = [
  "T-GNCC-00-SOURCE-BOUNDARY-BASELINE",
  "T-GNCC-01-STORE-SCHEMA-WRITER",
  "T-GNCC-02-ADMISSION-CLASSIFIER",
  "T-GNCC-03-PROJECTION-OUTBOX-APP",
  "T-GNCC-04-CONTEXT-COMPACTION",
  "T-GNCC-05-COGNITION-SOURCES",
  "T-GNCC-06-HISTORICAL-RECOVERY",
  "T-GNCC-07-E2E-CLOSEOUT",
];

const migratedDefaultSourceTargets = [
  {
    task: "T-GNCC-05-COGNITION-SOURCES",
    path: "packages/butler-agent/src/agent/context/working-memory.ts",
    snippets: ["readTranscript(input.sessionId)", "compact transcript-backed continuity notes"],
  },
  {
    task: "T-GNCC-05-COGNITION-SOURCES",
    path: "packages/butler-agent/src/agent/cognition/memory/exact-query.ts",
    snippets: ['source: "app-message-db" | "transcript-query-index"'],
  },
  {
    task: "T-GNCC-05-COGNITION-SOURCES",
    path: "packages/butler-agent/src/agent/cognition/memory/scripts/lib/conversation-sources.ts",
    snippets: ["readTranscript(input.sessionId)"],
  },
  {
    task: "T-GNCC-05-COGNITION-SOURCES",
    path: "packages/butler-agent/src/personalization/profiling.ts",
    snippets: ["const transcriptRead = readTranscriptTextObservations"],
  },
  {
    task: "T-GNCC-05-COGNITION-SOURCES",
    path: "packages/butler-agent/src/agent/cognition/consolidation/cycle.ts",
    snippets: ["transcript_scanned_event_count: transcriptCapture.scanned_event_count"],
  },
];

const allowedAuditTranscriptSurfaces = [
  "packages/butler-agent/src/test-support/harness/transcripts.ts",
  "packages/butler-agent/src/gateways/app/domain/sessions/transcript-reader.ts",
  "packages/butler-agent/scripts/session-transcript.ts",
];

const ignoredRepoLocalDocDirs = new Set([
  ".git",
  ".tmp",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

function collectRepoLocalPlanningDocs(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (ignoredRepoLocalDocDirs.has(entry)) continue;
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!stat.isFile()) continue;
      const name = basename(path);
      if (!/\.md$/iu.test(name)) continue;
      if (/(^|[-_.])(spec|plan|roadmap|handoff)([-_.]|$)/iu.test(name)) {
        found.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  visit(root);
  return found.sort();
}

test("gateway-neutral conversation core specs are canonical and reviewable", () => {
  const parent = readRepoOrLedgerFile(conversationCoreSpecs[0].path);

  for (const spec of conversationCoreSpecs) {
    expect(repoOrLedgerExists(spec.path), spec.path).toBe(true);
    expect(parent).toContain(spec.id);

    const text = readRepoOrLedgerFile(spec.path);
    expect(text).toContain(spec.id);
    expect(text).toContain("source of truth");
    expect(text).toContain("## Success Criteria");
    expect(text).toMatch(/## Review (Checklist|Criteria)/);

    for (const section of spec.sections) expect(text).toContain(section);
    for (const criterion of spec.criteria) expect(text).toContain(criterion);
  }
});

test("gateway-neutral conversation implementation work is task-addressable", () => {
  const work = readRepoOrLedgerFile(
    "project-ledger/projects/butler/work/W-GATEWAY-NEUTRAL-CONVERSATION-CORE/work.md",
  );
  const plan = readRepoOrLedgerFile(
    "project-ledger/projects/butler/plans/plan-gateway-neutral-conversation-core.md",
  );

  expect(work).toContain("No repo-local spec, plan, handoff, or roadmap document is part of this work.");
  expect(plan).toContain("Implementation work is tracked by `W-GATEWAY-NEUTRAL-CONVERSATION-CORE`.");

  for (const task of implementationTasks) {
    expect(work).toContain(task);
    expect(plan).toContain(task);
    expect(repoOrLedgerExists(
      `project-ledger/projects/butler/work/W-GATEWAY-NEUTRAL-CONVERSATION-CORE/tasks/${task}.md`,
    ), task).toBe(true);
  }
});

test("repo-local planning/spec Markdown artifacts are not reintroduced", () => {
  expect(collectRepoLocalPlanningDocs(process.cwd())).toEqual([]);
});

test("migrated default-source targets no longer use transcript as the cognition default", () => {
  const work = readRepoOrLedgerFile(
    "project-ledger/projects/butler/work/W-GATEWAY-NEUTRAL-CONVERSATION-CORE/work.md",
  );

  for (const target of migratedDefaultSourceTargets) {
    expect(work).toContain(target.task);
    const source = readRepoOrLedgerFile(target.path);
    for (const snippet of target.snippets) expect(source).not.toContain(snippet);
  }
});

test("audit transcript surfaces stay separate from default-source migration targets", () => {
  const migrationPaths = new Set(migratedDefaultSourceTargets.map((target) => target.path));

  for (const path of allowedAuditTranscriptSurfaces) {
    expect(migrationPaths.has(path), path).toBe(false);
    expect(repoOrLedgerExists(path), path).toBe(true);
    expect(readRepoOrLedgerFile(path)).toMatch(/transcript/i);
  }
});
