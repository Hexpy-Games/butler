import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCanonicalSpecRevisions } from
  "../../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/canonical-spec-resolver.ts";
import { loadProjectLedgerCore } from
  "../../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-ledger-core.ts";
import { loadFixtureCatalog, requiredFixtureRefs } from "./fixtures/fixture-catalog.ts";
import { materializeScenario } from "./fixtures/materialize-scenario.ts";
import {
  resolveFixtureProjectLedger,
  seedAppProjectBinding,
} from "./fixtures/project-ledger-binding.ts";
import {
  EXACT_MODEL_CELLS,
  loadLiveManifest,
  selectModelCells,
  sha256,
} from "./manifest/load-live-manifest.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "btcc-live-readiness-"));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe("BTCC live diagnostic readiness", () => {
  test("binds the exact model cells and complete authoritative scenario set", () => {
    const { manifest } = loadLiveManifest();
    expect(manifest.scenarios).toHaveLength(19);
    expect(manifest.scenarios.flatMap((scenario) => scenario.turns)).toHaveLength(22);
    expect(selectModelCells("matrix")).toEqual([...EXACT_MODEL_CELLS]);
  });

  test("materializes every declared fixture ref without a manual catalog", async () => {
    const { manifest } = loadLiveManifest();
    const catalog = loadFixtureCatalog(manifest.scenarios);
    expect([...catalog.entries.keys()].sort()).toEqual(requiredFixtureRefs(manifest.scenarios));
    for (const scenario of manifest.scenarios) {
      const fixture = materializeScenario({
        scenario,
        scenarioRoot: join(tempRoot, scenario.scenarioId),
        catalog,
      });
      const dbPath = join(fixture.butlerData, "runtime", "btcc-live.sqlite");
      seedAppProjectBinding({ dbPath, fixture });
      const ledger = resolveFixtureProjectLedger({ dbPath, fixture });
      expect(ledger?.initialized ?? true).toBe(true);
      if (ledger) {
        const specs = resolveCanonicalSpecRevisions(
          await loadProjectLedgerCore(),
          ledger.ledgerRoot,
          ["SPEC-LIVE-FIXTURE"],
        );
        expect(specs.map((spec) => spec.logicalId)).toEqual(["SPEC-LIVE-FIXTURE"]);
      }
      for (const turn of scenario.turns) {
        if (turn.inbound.kind !== "canonical_local_ref") continue;
        const content = fixture.canonicalMessages.get(turn.inbound.messageRef);
        expect(content).toBeDefined();
        expect(sha256(content!)).toBe(turn.inbound.contentSha256);
      }
    }
  });
});
