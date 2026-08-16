import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const repositoryRoot = resolve(import.meta.dir, "../..");
const btccRoot = join(repositoryRoot, "packages/butler-agent/src/agent/btcc");
const sourceRoot = join(repositoryRoot, "packages/butler-agent/src");

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/gu)]
    .map((match) => match[1]!)
    .filter(Boolean);
}

test("BTCC indexes are explicit export-only boundaries", () => {
  const indexPaths = filesUnder(btccRoot).filter((path) => path.endsWith("/index.ts"));
  expect(indexPaths.length).toBeGreaterThan(0);

  for (const path of indexPaths) {
    const source = readFileSync(path, "utf8");
    const sourceFile = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(source, relative(repositoryRoot, path)).not.toMatch(/export\s+\*/u);
    expect(
      sourceFile.statements.every((statement) => ts.isExportDeclaration(statement)),
      relative(repositoryRoot, path),
    ).toBe(true);
  }
});

test("BTCC exposes the canonical entry path and removes product compatibility paths", () => {
  const entrypoints = [
    "agent/btcc/btcc.ts",
    "agent/btcc/turn/turn.ts",
    "agent/btcc/agent-loop/agent-loop.ts",
    "agent/btcc/work/work.ts",
    "agent/btcc/effects/effects.ts",
    "agent/btcc/delivery/delivery.ts",
    "agent/btcc/projection/projection.ts",
  ];
  for (const entrypoint of entrypoints) {
    expect(existsSync(join(sourceRoot, entrypoint)), entrypoint).toBe(true);
  }

  for (const removedPath of [
    "agent/composition/production-btcc",
    "agent/btcc/guided-turn",
    "agent/btcc/durable-work",
  ]) {
    expect(existsSync(join(sourceRoot, removedPath)), removedPath).toBe(false);
  }

  const productSources = filesUnder(sourceRoot);
  for (const path of productSources) {
    const source = readFileSync(path, "utf8");
    for (const removedSpecifier of [
      "agent/composition/production-btcc",
      "agent/btcc/guided-turn",
      "agent/btcc/durable-work",
    ]) {
      expect(source, relative(repositoryRoot, path)).not.toContain(removedSpecifier);
    }
  }
});

test("Gateway consumes only the BTCC root API and composition remains wiring-only", () => {
  const gatewayRoot = join(sourceRoot, "interfaces/gateway");
  for (const path of filesUnder(gatewayRoot)) {
    expect(readFileSync(path, "utf8"), relative(repositoryRoot, path))
      .not.toContain("createProductionBtccComposition");
    for (const specifier of importSpecifiers(readFileSync(path, "utf8"))) {
      if (specifier.includes("agent/btcc/")) {
        expect(specifier, relative(repositoryRoot, path)).toMatch(/agent\/btcc\/index\.ts$/u);
      }
    }
  }

  const composition = readFileSync(
    join(sourceRoot, "agent/composition/create-btcc-composition.ts"),
    "utf8",
  );
  expect(composition).toContain("../btcc/index.ts");
  expect(composition).toContain("../btcc/turn/index.ts");
  expect(composition).toContain("../btcc/agent-loop/index.ts");
  expect(composition).not.toMatch(/model-tool-loop|production-btcc|guided-turn|durable-work/u);

  const rootApi = readFileSync(join(btccRoot, "index.ts"), "utf8");
  expect(rootApi).not.toMatch(
    /Btcc(?:Host|RunCommand|StopCommand|TurnRuntime|TurnPreparation|Progress|Wake|Prepared|AgentLoop)/u,
  );
  expect(rootApi).not.toMatch(/model-tool-loop|toolResult|structuredTool|preview|media/u);
});

test("BTCC keeps the host outside the consumer facade", () => {
  const facade = readFileSync(join(btccRoot, "btcc.ts"), "utf8");
  expect(facade).toContain("btcc: { runTurn, stopTurn }");
  expect(facade).not.toMatch(/return\s*\{\s*runTurn,\s*stopTurn,\s*host/su);
});

test("BTCC child domains use each other through public indexes", () => {
  const childDomains = new Set([
    "agent-loop",
    "delivery",
    "effects",
    "projection",
    "recovery",
    "turn",
    "work",
  ]);

  for (const path of filesUnder(btccRoot)) {
    const sourceDomain = childDomain(path, childDomains);
    if (!sourceDomain) continue;
    for (const specifier of importSpecifiers(readFileSync(path, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      const targetDomain = childDomain(resolve(dirname(path), specifier), childDomains);
      if (!targetDomain || targetDomain === sourceDomain) continue;
      expect(
        specifier,
        `${relative(repositoryRoot, path)} -> ${specifier}`,
      ).toMatch(/(?:^|\/)index\.ts$/u);
    }
  }
});

test("Native Butler alone owns BTCC composition and the retired Steward is absent", () => {
  const nativeButler = "application/native-butler.ts";
  const nativeSteward = "application/native-steward.ts";
  expect(existsSync(join(sourceRoot, nativeButler)), nativeButler).toBe(true);
  expect(readFileSync(join(sourceRoot, nativeButler), "utf8"), nativeButler)
    .toContain("createProductionBtccComposition");
  expect(existsSync(join(sourceRoot, nativeSteward)), nativeSteward).toBe(false);

  for (const removedPath of [
    "interfaces/gateway/native-butler-bootstrap.ts",
    "interfaces/gateway/native-steward-bootstrap.ts",
  ]) {
    expect(existsSync(join(sourceRoot, removedPath)), removedPath).toBe(false);
  }

  const nativeMainScript = "packages/butler-agent/scripts/native-butler-main.ts";
  expect(readFileSync(join(repositoryRoot, nativeMainScript), "utf8"))
    .toContain("src/application/native-butler.ts");
  expect(existsSync(join(
    repositoryRoot,
    "packages/butler-agent/scripts/native-steward-turn.ts",
  ))).toBe(false);
});

function childDomain(path: string, childDomains: Set<string>): string | null {
  const relativePath = relative(btccRoot, path);
  const domain = relativePath.split(/[\\/]/u)[0];
  return domain && childDomains.has(domain) ? domain : null;
}
