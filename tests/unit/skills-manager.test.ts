import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  importSkillZip,
  listSkillProjectsInDataHome,
  loadRuntimeSkills,
  skillSettingsView,
  validateSkillSettings,
} from "../../packages/butler-agent/src/integrations/skills/manager.ts";

let tempHome = "";
let tempData = "";
let tempSource = "";

beforeEach(() => {
  tempHome = mkdtempSync(`${tmpdir()}/butler-skills-home-`);
  tempData = mkdtempSync(`${tmpdir()}/butler-skills-data-`);
  tempSource = mkdtempSync(`${tmpdir()}/butler-skills-source-`);
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempData, { recursive: true, force: true });
  rmSync(tempSource, { recursive: true, force: true });
});

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "applicability: Use when the model decides the test fixture is relevant.",
    "allowed-tools: run_command",
    "reporting: concise",
    "user-invocable: true",
    "---",
    "",
    `# ${name}`,
    "",
    "Use this skill for test coverage.",
  ].join("\n"), "utf8");
}

function zipSkillArchive(skillDirName: string): ArrayBuffer {
  const zipPath = join(tempSource, `${skillDirName}.zip`);
  const result = spawnSync("zip", ["-qr", zipPath, skillDirName], {
    cwd: tempSource,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  const bytes = readFileSync(zipPath);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test("skill manager separates core user and project skills under Butler data home", () => {
  writeSkill(join(tempHome, "resources", "skills", "core-fixture"), "core-fixture", "Core fixture");
  writeSkill(join(tempSource, "user-fixture"), "user-fixture", "User fixture");
  const userZip = zipSkillArchive("user-fixture");

  expect(importSkillZip({
    butlerData: tempData,
    zipName: "user-fixture.zip",
    bytes: userZip,
  }).imported[0]).toMatchObject({
    name: "user-fixture",
    source: "user",
  });

  writeSkill(join(tempSource, "project-fixture"), "project-fixture", "Project fixture");
  const projectZip = zipSkillArchive("project-fixture");
  expect(importSkillZip({
    butlerData: tempData,
    zipName: "project-fixture.zip",
    bytes: projectZip,
    projectId: "project-alpha",
  }).imported[0]).toMatchObject({
    name: "project-fixture",
    source: "project",
    project_id: "project-alpha",
  });

  const settings = skillSettingsView({
    butlerHome: tempHome,
    butlerData: tempData,
    projects: [{ id: "project-alpha", display_name: "Project Alpha" }],
  });
  expect(settings.storage_root).toBe(join(tempData, "skills"));
  expect(settings.core.map((skill) => skill.name)).toEqual(["core-fixture"]);
  expect(settings.user.map((skill) => skill.name)).toEqual(["user-fixture"]);
  expect(settings.projects[0]?.skills.map((skill) => skill.name)).toEqual(["project-fixture"]);

  const runtimeSkills = loadRuntimeSkills({
    butlerHome: tempHome,
    butlerData: tempData,
    projectId: "project-alpha",
  });
  expect(runtimeSkills.map((skill) => skill.name).sort()).toEqual([
    "core-fixture",
    "project-fixture",
    "user-fixture",
  ]);
  expect(settings.user[0]?.file_path.startsWith(join(tempData, "skills", "default"))).toBe(true);
  expect(settings.projects[0]?.skills[0]?.file_path.startsWith(join(tempData, "skills", "projects"))).toBe(true);
  expect(listSkillProjectsInDataHome(tempData).map((project) => project.id)).toEqual(["project-alpha"]);
  expect(validateSkillSettings({
    butlerHome: tempHome,
    butlerData: tempData,
  })).toMatchObject({
    ok: true,
    counts: {
      core: 1,
      user: 1,
      project: 1,
    },
    issues: [],
  });
});
