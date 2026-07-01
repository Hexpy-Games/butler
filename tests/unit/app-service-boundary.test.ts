import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const GENERATED_SOURCE_DIRS = new Set([".vite", "coverage", "dist", "node_modules"]);

function pathExists(path: string): boolean {
  return existsSync(join(root, path));
}

function sourceFiles(dir: string): string[] {
  if (!pathExists(dir)) return [];
  return readdirSync(join(root, dir)).flatMap((entry) => {
    const absolute = join(root, dir, entry);
    const relative = `${dir}/${entry}`;
    if (statSync(absolute).isDirectory()) {
      if (GENERATED_SOURCE_DIRS.has(entry)) return [];
      return sourceFiles(relative);
    }
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(entry)) return [];
    return [relative];
  });
}

function importSpecifiersUnder(dir: string): string[] {
  return sourceFiles(dir)
    .flatMap((file) => {
      const source = readFileSync(join(root, file), "utf8");
      return [...source.matchAll(/from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)/gu)]
        .map((match) => `${file} ${match[1] ?? match[2]}`);
    })
    .sort();
}

function sourceTextMatchesUnder(dir: string, pattern: RegExp): string[] {
  return sourceFiles(dir)
    .filter((file) => pattern.test(readFileSync(join(root, file), "utf8")))
    .sort();
}

test("Butler App has no server runtime package", () => {
  expect(pathExists("packages/butler-app/server")).toBe(false);
});

test("Butler App client and scripts do not import Butler Agent internals", () => {
  const imports = [
    ...importSpecifiersUnder("packages/butler-app/client"),
    ...importSpecifiersUnder("packages/butler-app/scripts"),
  ];

  expect(imports.filter((line) => line.includes("butler-agent/src"))).toEqual([]);
  expect(sourceTextMatchesUnder("packages/butler-app", /packages\/butler-agent\/src/u)).toEqual([]);
});

test("temporary service and gateway protocol packages are removed", () => {
  expect(pathExists("packages/butler-service-api")).toBe(false);
  expect(pathExists("packages/butler-gateway-protocol")).toBe(false);
});

test("Butler Agent owns gateway core and app gateway runtime", () => {
  expect(pathExists("packages/butler-agent/src/gateways/core/contracts.ts")).toBe(true);
  expect(pathExists("packages/butler-agent/src/gateways/core/server.ts")).toBe(true);
  expect(pathExists("packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts")).toBe(true);
  expect(pathExists("packages/butler-agent/src/gateways/app/application/store/app-server-store.ts")).toBe(true);
  expect(pathExists("packages/butler-agent/src/gateways/app/interface/protocol/app-protocol.ts")).toBe(true);
  expect(
    sourceFiles("packages/butler-agent/src/gateways/app").filter(
      (file) => file.split("/").length === 6,
    ),
  ).toEqual([]);
});

test("agent-owned gateways do not import app package code", () => {
  const imports = [
    ...importSpecifiersUnder("packages/butler-agent/src/gateways/core"),
    ...importSpecifiersUnder("packages/butler-agent/src/gateways/app"),
  ];

  expect(imports.filter((line) => line.includes("butler-app/"))).toEqual([]);
});
