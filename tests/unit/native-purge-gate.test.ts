import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const root = join(import.meta.dir, "../..");

test("native purge gate accepts official provider source URLs", () => {
  const anthropicCatalog = readFileSync(
    join(root, "packages/butler-agent/src/integrations/providers/anthropic/catalog.ts"),
    "utf8",
  );
  expect(anthropicCatalog).toContain("platform.claude.com");

  expect(() => execFileSync("bash", ["tests/unit/native-purge-gate.sh"], {
    cwd: root,
    stdio: "pipe",
  })).not.toThrow();
}, 15_000);
