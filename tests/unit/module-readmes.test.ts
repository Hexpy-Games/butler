import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const root = process.cwd();

const moduleReadmes = [
  "packages/butler-agent/src/README.md",
  "packages/butler-agent/src/interfaces/cli/README.md",
  "packages/butler-agent/src/agent/context/README.md",
  "packages/butler-agent/src/interfaces/gateway/README.md",
  "packages/butler-agent/src/test-support/harness/README.md",
  "packages/butler-agent/src/operations/install/README.md",
  "packages/butler-agent/src/integrations/README.md",
  "packages/butler-agent/src/integrations/project-ledger/README.md",
  "packages/butler-agent/src/integrations/providers/README.md",
  "packages/butler-agent/src/integrations/telegram/README.md",
  "packages/butler-agent/src/interfaces/mcp-server/README.md",
  "packages/butler-agent/src/interfaces/mcp-server/checks/README.md",
  "packages/butler-agent/src/agent/cognition/memory/README.md",
  "packages/butler-agent/src/agent/cognition/memory/recall/README.md",
  "packages/butler-agent/src/agent/cognition/memory/scripts/README.md",
  "packages/butler-agent/src/operations/README.md",
  "packages/butler-agent/src/operations/release/README.md",
  "packages/butler-agent/src/gateways/core/README.md",
  "packages/butler-agent/src/gateways/app/README.md",
  "packages/butler-agent/src/agent/README.md",
  "packages/butler-agent/src/integrations/search/README.md",
  "packages/butler-agent/src/integrations/skills/README.md",
  "packages/butler-agent/src/agent/work/README.md",
  "packages/butler-agent/src/interfaces/transport/README.md",
  "packages/butler-agent/src/interfaces/transport/mock/README.md",
  "packages/butler-agent/src/interfaces/transport/telegram/README.md",
  "packages/butler-agent/scripts/README.md",
  "packages/butler-agent/resources/README.md",
  "packages/butler-app/README.md",
  "packages/butler-app/client/README.md",
  "packages/butler-app/scripts/README.md",
  "packages/butler-app/scripts/lint/README.md",
  "packages/project-ledger/README.md",
  "tools/README.md",
  "tools/validation/README.md",
  "tests/README.md",
];

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function normalizeSpecTitle(title: string): string {
  return title
    .replace(/^Spec(?:\s+\d+)?:\s*/i, "")
    .replace(/\s+Spec$/i, "")
    .trim();
}

function readSpecTitles(): Map<string, string> {
  const specs = new Map<string, string>();
  const defaultButlerData = join(homedir(), ".butler");
  const butlerDataRoots = [
    process.env.BUTLER_DATA,
    defaultButlerData,
  ].filter((value): value is string => Boolean(value));
  const specRoots = [
    join(root, ".project-ledger", "specs"),
    ...butlerDataRoots.map((butlerData) =>
      join(butlerData, "project-ledger", "projects", "butler", "specs"),
    ),
    ...(process.env.PROJECT_LEDGER_REPO
      ? [join(process.env.PROJECT_LEDGER_REPO, "projects", "butler", "specs")]
      : []),
  ].filter((path, index, paths) => paths.indexOf(path) === index && existsSync(path));

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith(".md")) continue;

      const markdown = readFileSync(path, "utf8");
      const id = markdown.match(/^id:\s*["']?([^"'\n]+)["']?/m)?.[1];
      const title = markdown.match(/^title:\s*["']?([^"'\n]+)["']?/m)?.[1] ?? markdown.match(/^#\s+(.+)$/m)?.[1];
      if (id && title) specs.set(id, normalizeSpecTitle(title));
    }
  }

  for (const specRoot of specRoots) walk(specRoot);
  return specs;
}

function specReferencesFrom(markdown: string): Array<{ id: string; title: string }> {
  const section = markdown.split("## Related Specs")[1] ?? "";
  return [...section.matchAll(/^- `([A-Z0-9-]+)` - ([^\n]+)/gm)].map((match) => ({
    id: match[1]!,
    title: match[2]!.trim(),
  }));
}

test("module top-level READMEs exist and reference governing specs by Ledger id and title", () => {
  const specTitles = readSpecTitles();

  for (const readme of moduleReadmes) {
    expect(existsSync(join(root, readme))).toBe(true);
    const markdown = readRepoFile(readme);

    expect(markdown).toMatch(/^# .+/);
    expect(markdown).toContain("## Related Specs");
    expect(markdown).not.toContain("docs/specs/");

    const references = specReferencesFrom(markdown);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(specTitles.has(reference.id)).toBe(true);
      const expectedTitle = specTitles.get(reference.id);
      expect(expectedTitle).toBeDefined();
      expect(reference.title).toBe(expectedTitle!);
    }
  }
});
