import { afterEach, describe, expect, test } from "bun:test";
import { discoverSuccessorModulesFromPaths } from "../discover-successor-modules.ts";
import { verifyDiscoveredSuccessorShape } from "../verify-source-shape.ts";
import {
  createFixtureRepository,
  type FixtureRepository,
} from "./fixture-repository.ts";

const fixtures: FixtureRepository[] = [];

function fixture(): FixtureRepository {
  const repository = createFixtureRepository();
  fixtures.push(repository);
  return repository;
}

function findingCodes(repository: FixtureRepository): string[] {
  return inspect(repository)
    .findings.map((finding) => finding.code);
}

function inspect(repository: FixtureRepository) {
  const discovered = discoverSuccessorModulesFromPaths(
    repository.root,
    repository.changedPaths,
  );
  return verifyDiscoveredSuccessorShape(repository.root, discovered);
}

afterEach(() => fixtures.splice(0).forEach((repository) => repository.remove()));

describe("BTCC successor source shape", () => {
  test("does nothing before successor roots are materialized", () => {
    const repository = fixture();

    expect(inspect(repository)).toEqual({
      inspectedDomains: 0,
      inspectedFiles: 0,
      findings: [],
    });
  });

  test("allows explicit public APIs and cross-domain imports through index.ts", () => {
    const repository = fixture();
    repository.write(
      "packages/butler-agent/src/agent/btcc/index.ts",
      'export { runTurn } from "./run-turn.ts";\n',
    );
    repository.write(
      "packages/butler-agent/src/agent/btcc/run-turn.ts",
      "export function runTurn(): string { return \"done\"; }\n",
    );
    repository.write(
      "packages/butler-agent/src/agent/composition/index.ts",
      'export { composeTurn } from "./compose-turn.ts";\n',
    );
    repository.write(
      "packages/butler-agent/src/agent/composition/compose-turn.ts",
      'import { runTurn } from "../btcc/index.ts";\n'
        + "export function composeTurn(): string { return runTurn(); }\n",
    );

    expect(inspect(repository).findings).toEqual([]);
  });

  test("rejects every literal dependency form that resolves into legacy BTCC", () => {
    const repository = fixture();
    repository.write(
      "packages/butler-agent/src/agent/btcc/index.ts",
      'export { current } from "./current.ts";\n',
    );
    repository.write(
      "packages/butler-agent/src/agent/btcc/current.ts",
      "export const current = true;\n",
    );
    repository.write(
      "packages/butler-agent/src/agent/btcc/legacy-references.ts",
      'import { legacyTurn } from "../turn/legacy.ts";\n'
        + 'export { legacyWork } from "../work/legacy.ts";\n'
        + 'const loaded = require("../turn/legacy.ts");\n'
        + 'void import("../work/legacy.ts");\n'
        + "void legacyTurn; void loaded;\n",
    );
    repository.write(
      "packages/butler-agent/src/agent/turn/legacy.ts",
      "export const legacyTurn = true;\n",
    );
    repository.write(
      "packages/butler-agent/src/agent/work/legacy.ts",
      "export const legacyWork = true;\n",
    );

    expect(findingCodes(repository)).toEqual([
      "legacy_dependency",
      "legacy_dependency",
      "legacy_dependency",
      "legacy_dependency",
    ]);
  });

  test("keeps the boundary check on successor source instead of auditing shared dependencies", () => {
    const repository = fixture();
    repository.write(
      "packages/butler-agent/src/agent/btcc/index.ts",
      'export { runTurn } from "./run-turn.ts";\n',
    );
    repository.write(
      "packages/butler-agent/src/agent/btcc/run-turn.ts",
      'import { bridge } from "../context/bridge.ts";\n'
        + "export const runTurn = bridge;\n",
    );
    repository.write(
      "packages/butler-agent/src/agent/context/bridge.ts",
      'import { legacyTurn } from "../turn/legacy.ts";\n'
        + "export const bridge = legacyTurn;\n",
      false,
    );
    repository.write(
      "packages/butler-agent/src/agent/turn/legacy.ts",
      "export const legacyTurn = true;\n",
      false,
    );

    expect(findingCodes(repository)).toEqual([]);
  });

  test("does not impose successor style rules on an unchanged public dependency", () => {
    const repository = fixture();
    repository.write(
      "packages/butler-agent/src/agent/btcc/index.ts",
      'export { runTurn } from "./run-turn.ts";\n',
    );
    repository.write(
      "packages/butler-agent/src/agent/btcc/run-turn.ts",
      'import { conversationStore } from "../conversation/index.ts";\n'
        + "export const runTurn = conversationStore;\n",
    );
    repository.write(
      "packages/butler-agent/src/agent/conversation/index.ts",
      'export * from "./store.ts";\n',
      false,
    );
    repository.write(
      "packages/butler-agent/src/agent/conversation/store.ts",
      "export const conversationStore = true;\n" + "// existing style debt\n".repeat(350),
      false,
    );

    expect(inspect(repository).findings).toEqual([]);
  });

  test("requires every materialized domain to name an API in index.ts", () => {
    const repository = fixture();
    repository.write(
      "packages/butler-agent/src/agent/adapters/internal.ts",
      "export const adapter = true;\n",
    );
    repository.write(
      "packages/butler-agent/src/agent/btcc/index.ts",
      'import "./internal.ts";\n',
    );
    repository.write(
      "packages/butler-agent/src/agent/btcc/internal.ts",
      "export const internal = true;\n",
    );

    expect(findingCodes(repository)).toEqual([
      "public_index_missing",
      "explicit_api_missing",
    ]);
  });

  test("rejects wildcard exports", () => {
    const repository = fixture();
    repository.write(
      "packages/butler-agent/src/agent/btcc/index.ts",
      'export * from "./run-turn.ts";\n',
    );
    repository.write(
      "packages/butler-agent/src/agent/btcc/run-turn.ts",
      "export const runTurn = true;\n",
    );

    expect(findingCodes(repository)).toEqual([
      "explicit_api_missing",
      "wildcard_export",
    ]);
  });

  test("rejects cross-domain deep imports when a public index exists", () => {
    const repository = fixture();
    repository.write(
      "packages/butler-agent/src/agent/btcc/index.ts",
      'export { runTurn } from "./run-turn.ts";\n',
    );
    repository.write(
      "packages/butler-agent/src/agent/btcc/run-turn.ts",
      "export const runTurn = true;\n",
    );
    repository.write(
      "packages/butler-agent/src/agent/composition/index.ts",
      'export { composeTurn } from "./compose-turn.ts";\n',
    );
    repository.write(
      "packages/butler-agent/src/agent/composition/compose-turn.ts",
      'import { runTurn } from "../btcc/run-turn.ts";\n'
        + "export const composeTurn = runTurn;\n",
    );

    expect(findingCodes(repository)).toEqual(["cross_domain_deep_import"]);
  });

  test("allows adapters to consume the explicit BTCC gateway boundary", () => {
    const repository = fixture();
    repository.write(
      "packages/butler-agent/src/agent/btcc/index.ts",
      'export { runTurn } from "./run-turn.ts";\n',
    );
    repository.write(
      "packages/butler-agent/src/agent/btcc/gateway-api.ts",
      "export type GatewayPort = { readonly kind: 'gateway' };\n",
    );
    repository.write(
      "packages/butler-agent/src/agent/adapters/index.ts",
      'export { adapter } from "./adapter.ts";\n',
    );
    repository.write(
      "packages/butler-agent/src/agent/adapters/adapter.ts",
      'import type { GatewayPort } from "../btcc/gateway-api.ts";\n'
        + "export const adapter: GatewayPort = { kind: 'gateway' };\n",
    );

    expect(findingCodes(repository)).toEqual([]);
  });

  test("enforces the physical line limit in successor source and test roots", () => {
    const repository = fixture();
    repository.write(
      "packages/butler-agent/src/agent/btcc/index.ts",
      'export { runTurn } from "./run-turn.ts";\n',
    );
    repository.write(
      "packages/butler-agent/src/agent/btcc/run-turn.ts",
      "export const line = 1;\n".repeat(351),
    );
    repository.write(
      "tests/unit/btcc/run-turn.test.ts",
      "const line = 1;\n".repeat(351),
    );

    expect(findingCodes(repository)).toEqual([
      "line_limit_exceeded",
      "line_limit_exceeded",
    ]);
  });
});
