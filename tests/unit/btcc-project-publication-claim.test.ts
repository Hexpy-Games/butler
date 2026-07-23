import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createProjectWorkLedgerPublicationAdapter } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { loadProjectLedgerCore } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-ledger-core.ts";
import {
  canonicalMutationId,
  clearProjectFixtures,
  projectBindingCommit,
  projectFixture,
  reviewedPlan,
} from "./support/btcc-project-ledger-fixture.ts";

afterEach(clearProjectFixtures);

test("observed publications release exact claims and leave the root available", async () => {
  const fixture = await projectFixture();
  const core = await loadProjectLedgerCore();
  const adapter = createProjectWorkLedgerPublicationAdapter({
    stagingRoot: join(fixture.root, "staging"),
  });
  const binding = projectBindingCommit();
  const prepared = await adapter.prepareCommit({
    projectRoot: fixture.ledgerRoot,
    expectedBase: await adapter.observeCanonicalHead(fixture.ledgerRoot),
    commit: binding.commit,
  });
  const publication = prepared.publication;

  await adapter.promoteAndObserve(publication);
  expect(existsSync(publication.corePublication.claimPath)).toBe(false);

  core.reconcilePublicationClaim(
    publication.corePublication.claimPath,
    { ...publication.corePublication, status: "observed" },
    true,
  );
  expect(existsSync(publication.corePublication.claimPath)).toBe(false);

  const accepted = reviewedPlan({
    goalContractRef: binding.goalContract.ref,
    authorityRef: binding.authority.ref,
    availableSpecRefs: prepared.program.availableSpecRefs,
    governingSpecSelections: [prepared.program.availableSpecs[0]!.logicalId],
    requireGoverningSpec: true,
  });
  const nextCommit = {
    mutationId: "",
    turnId: "turn-after-observed-publication",
    expectedTurnRevision: 4,
    mutation: { kind: "install_reviewed_plan" as const, product: accepted },
  };
  nextCommit.mutationId = canonicalMutationId(nextCommit, prepared.program);
  await expect(adapter.prepareCommit({
    projectRoot: fixture.ledgerRoot,
    expectedBase: await adapter.observeCanonicalHead(fixture.ledgerRoot),
    commit: nextCommit,
  })).resolves.toMatchObject({ program: { planningState: "reviewed" } });
});

test("startup reconciliation releases an exact observed crash-gap claim", async () => {
  const fixture = await projectFixture();
  const core = await loadProjectLedgerCore();
  const adapter = createProjectWorkLedgerPublicationAdapter({
    stagingRoot: join(fixture.root, "staging"),
  });
  const prepared = await adapter.prepareCommit({
    projectRoot: fixture.ledgerRoot,
    expectedBase: await adapter.observeCanonicalHead(fixture.ledgerRoot),
    commit: projectBindingCommit().commit,
  });
  await adapter.promoteAndObserve(prepared.publication);
  core.reconcilePublicationClaim(
    prepared.publication.corePublication.claimPath,
    prepared.publication.corePublication,
    true,
  );
  expect(existsSync(prepared.publication.corePublication.claimPath)).toBe(true);

  await adapter.reconcileOrphanedPublications([
    prepared.publication.corePublication.publicationId,
  ]);
  expect(existsSync(prepared.publication.corePublication.claimPath)).toBe(false);
});
