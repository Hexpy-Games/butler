import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("Project Ledger PL-0 documents the governing plan spec and ADR", () => {
  const planPath = ".project-ledger/plans/plan-project-ledger.md";
  const specPath = ".project-ledger/specs/project-ledger.md";
  const adrPath = ".project-ledger/decisions/0001-project-ledger-repo-first-skill-packaged-cli.md";

  expect(existsSync(join(root, planPath))).toBe(true);
  expect(existsSync(join(root, specPath))).toBe(true);
  expect(existsSync(join(root, adrPath))).toBe(true);

  const plan = readRepoFile(planPath);
  const spec = readRepoFile(specPath);
  const adr = readRepoFile(adrPath);

  expect(plan).toContain("This plan implements `docs/specs/project-ledger.md`");
  expect(plan).toContain("| PL-1 | Skill-packaged CLI MVP | Complete |");
  expect(spec).toContain("This spec defines Project Ledger");
  expect(spec).toContain("Status: Native CLI complete");
  expect(adr).toContain("Repo-First And Skill-Packaged");
});

test("Project Ledger plan includes all fixed phases and MVP commands", () => {
  const plan = readRepoFile(".project-ledger/plans/plan-project-ledger.md");

  for (const phase of ["PL-0", "PL-1", "PL-2", "PL-3", "PL-4", "PL-5", "PL-6", "PL-7"]) {
    expect(plan).toContain(phase);
  }

  for (const command of [
    "project-ledger init --project PATH --id ID --name NAME",
    "project-ledger index --project PATH --json",
    "project-ledger status --project PATH --json",
    "project-ledger query --project PATH --kind",
    "project-ledger render --project PATH dashboard|handoff|roadmap [--write]",
    "project-ledger doctor --project PATH --json",
  ]) {
    expect(plan).toContain(command);
  }

  expect(plan).toContain("packages/project-ledger/");
  expect(plan).toContain("<target-repo>/.project-ledger/");
  expect(plan).toContain("compact JSON");
});

test("Project Ledger spec defines source of truth layout privacy and success criteria", () => {
  const spec = readRepoFile(".project-ledger/specs/project-ledger.md");

  expect(spec).toContain("## Source Of Truth");
  expect(spec).toMatch(/Generated views are not source\s+of truth/);
  expect(spec).toContain("## MVP Command Contract");
  expect(spec).toContain("## Record Layout");
  expect(spec).toContain(".project-ledger/");
  expect(spec).toContain("Private transcripts, credentials, raw prompts");
  expect(spec).toContain("## Skill Contract");
  expect(spec).toContain("## Success Criteria");
  expect(spec).toContain("PL-SC01");
  expect(spec).toContain("PL-SC10");
  expect(spec).toContain("tests/unit/project-ledger-plan.test.ts");
});

test("Project Ledger ADR records rejected alternatives and Butler decoupling", () => {
  const adr = readRepoFile(".project-ledger/decisions/0001-project-ledger-repo-first-skill-packaged-cli.md");

  expect(adr).toContain("Accepted");
  expect(adr).toContain("Butler-only tool: rejected");
  expect(adr).toContain("Skill-only prompt workflow: rejected");
  expect(adr).toContain("Skill-first source");
  expect(adr).toContain("Butler integration must remain an adapter");
});
