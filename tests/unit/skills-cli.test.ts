import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const root = process.cwd();
const cli = join(root, "bin", "butler.js");

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
    "Use this skill for CLI coverage.",
  ].join("\n"), "utf8");
}

function zipSkill(sourceRoot: string, dirName: string): string {
  const zipPath = join(sourceRoot, `${dirName}.zip`);
  const result = spawnSync("zip", ["-qr", zipPath, dirName], {
    cwd: sourceRoot,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return zipPath;
}

function runCli(args: string[], butlerHome: string, butlerData: string) {
  return Bun.spawnSync(["node", cli, ...args, "--home", butlerHome, "--data", butlerData], {
    cwd: root,
    env: {
      ...process.env,
      BUTLER_HOME: butlerHome,
      BUTLER_DATA: butlerData,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function stdoutText(result: ReturnType<typeof runCli>): string {
  return new TextDecoder().decode(result.stdout);
}

test("skills CLI lists validates inspects and imports data-home skills", () => {
  const butlerHome = mkdtempSync(`${tmpdir()}/butler-skills-cli-home-`);
  const butlerData = mkdtempSync(`${tmpdir()}/butler-skills-cli-data-`);
  const sourceRoot = mkdtempSync(`${tmpdir()}/butler-skills-cli-source-`);
  try {
    writeSkill(join(butlerHome, "resources", "skills", "core-fixture"), "core-fixture", "Core fixture");
    writeSkill(join(sourceRoot, "user-fixture"), "user-fixture", "User fixture");
    writeSkill(join(sourceRoot, "project-fixture"), "project-fixture", "Project fixture");

    const userImport = runCli(["skills", "import", zipSkill(sourceRoot, "user-fixture"), "--json"], butlerHome, butlerData);
    expect(userImport.exitCode).toBe(0);
    expect(JSON.parse(stdoutText(userImport)).data.imported[0]).toMatchObject({
      name: "user-fixture",
      source: "user",
    });

    const projectImport = runCli([
      "skills",
      "import",
      zipSkill(sourceRoot, "project-fixture"),
      "--project",
      "project-alpha",
      "--json",
    ], butlerHome, butlerData);
    expect(projectImport.exitCode).toBe(0);
    expect(JSON.parse(stdoutText(projectImport)).data.imported[0]).toMatchObject({
      name: "project-fixture",
      source: "project",
      project_id: "project-alpha",
    });

    const list = runCli(["skills", "list", "--project", "project-alpha", "--json"], butlerHome, butlerData);
    expect(list.exitCode).toBe(0);
    const listed = JSON.parse(stdoutText(list)).data;
    expect(listed.core.map((skill: any) => skill.name)).toEqual(["core-fixture"]);
    expect(listed.user.map((skill: any) => skill.name)).toEqual(["user-fixture"]);
    expect(listed.projects[0].skills.map((skill: any) => skill.name)).toEqual(["project-fixture"]);

    const inspect = runCli(["skills", "inspect", "project-fixture", "--project", "project-alpha", "--json"], butlerHome, butlerData);
    expect(inspect.exitCode).toBe(0);
    expect(JSON.parse(stdoutText(inspect)).data.skills[0]).toMatchObject({
      source: "project",
      project_id: "project-alpha",
    });

    const validate = runCli(["skills", "validate", "--project", "project-alpha", "--json"], butlerHome, butlerData);
    expect(validate.exitCode).toBe(0);
    expect(JSON.parse(stdoutText(validate)).data).toMatchObject({
      ok: true,
      counts: {
        core: 1,
        user: 1,
        project: 1,
      },
      issues: [],
    });
  } finally {
    rmSync(butlerHome, { recursive: true, force: true });
    rmSync(butlerData, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  }
});
