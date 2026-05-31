import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadSkillCatalog,
  renderSkillPromptSection,
  validateSkillCatalog,
} from "../../packages/butler-agent/src/integrations/skills/catalog.ts";

const skillsDir = join(process.cwd(), "packages", "butler-agent", "resources", "skills");

test("all bundled skills expose machine-readable strategy metadata", () => {
  const skills = loadSkillCatalog(skillsDir);

  expect(skills.map((skill) => skill.name)).toEqual([
    "butler-model",
    "butler-ship-feature",
    "dispatch",
    "persona",
    "project",
    "project-ledger",
    "restart",
    "save-feedback",
    "status",
  ]);
  expect(validateSkillCatalog(skills)).toEqual([]);
  expect(skills.find((skill) => skill.name === "dispatch")).toMatchObject({
    dispatchPreference: "auto",
    reviewRequirement: "recommended",
  });
});

test("skill catalog exposes applicability without text selection", () => {
  const skills = loadSkillCatalog(skillsDir);

  expect(skills.find((skill) => skill.name === "status")?.applicability).toContain("model decides");
  expect(skills.find((skill) => skill.name === "dispatch")?.applicability).toContain("model decides");
});

test("skill prompt section includes dispatch and review guidance", () => {
  const section = renderSkillPromptSection(loadSkillCatalog(skillsDir));

  expect(section).toContain("dispatch: Dispatch a task");
  expect(section).toContain("applicability:");
  expect(section).toContain("dispatch: auto; review: recommended");
  expect(section).toContain("status: Check butler system status");
});

test("invalid skill definitions fail validation", () => {
  const root = join(tmpdir(), `butler-invalid-skill-${Date.now()}`);
  const dir = join(root, "broken");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---
name: broken
description:
user-invocable: true
---

`, "utf8");

  try {
    const skills = loadSkillCatalog(root);
    expect(validateSkillCatalog(skills).map((issue) => issue.message)).toEqual([
      "description is required",
      "applicability is required",
      "allowed-tools are required",
      "reporting is required",
      "instructions body is required",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
