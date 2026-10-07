import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const eolPath = join(process.cwd(), "packages", "butler-agent", "resources", "eol.md");
const templatePath = join(process.cwd(), "packages", "butler-agent", "resources", "templates", "eol.template.md");
test("default install template matches the bundled runtime EOL", () => {
  expect(readFileSync(templatePath, "utf8")).toBe(readFileSync(eolPath, "utf8"));
});
