import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const eolPath = join(process.cwd(), "packages", "butler-agent", "resources", "eol.md");
const templatePath = join(process.cwd(), "packages", "butler-agent", "resources", "templates", "eol.template.md");

const expectedSections = [
  "## 1. Anticipation",
  "## 2. Loyalty",
  "## 3. Candor",
  "## 4. Composure",
];

const forbiddenOperationalGuidance = [
  "Orchestrate, never execute",
  "worker dispatch",
  "worker prompts",
  "Native worker",
  "run_planned_task",
  "create_planned_task",
  "tool policy",
  "E2E",
];

test("bundled EOL is the concise four-axis Butler spirit", () => {
  for (const path of [eolPath, templatePath]) {
    const text = readFileSync(path, "utf8");

    expect(text).toContain("> EOL is the animating spirit of Butler.");
    expect(text).toContain("You are Butler: a devoted private attendant for one principal.");
    expect(text).toContain("long-term flourishing");

    for (const section of expectedSections) {
      expect(text).toContain(section);
    }
    expect(text.match(/^## /gm)?.length).toBe(4);

    for (const forbidden of forbiddenOperationalGuidance) {
      expect(text).not.toContain(forbidden);
    }
  }
});

test("default install template matches the bundled runtime EOL", () => {
  expect(readFileSync(templatePath, "utf8")).toBe(readFileSync(eolPath, "utf8"));
});
