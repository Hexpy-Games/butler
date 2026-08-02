import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProjectLedgerRecordUpdates } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/external-effect-mutation.ts";

test("R3 Project Ledger publication keeps canonical metadata after staging promotion", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-ledger-publication-metadata-"));
  const butlerData = join(root, "butler-data");
  const projectId = "fixture-project";
  const projectRoot = join(butlerData, "project-ledger", "projects", projectId);
  const canonicalPrefix = `project-ledger/projects/${projectId}`;
  const previousButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = butlerData;

  try {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, "project.json"), `${JSON.stringify({
      schema: "project-ledger.project.v1",
      id: projectId,
      name: "Fixture project",
      status: "active",
    }, null, 2)}\n`);
    writeFileSync(join(projectRoot, "ledger.jsonl"), "");

    const result = await applyProjectLedgerRecordUpdates({
      butlerData,
      projectRoot,
      effectKey: "canonical-publication-metadata",
      updates: [{
        operation: "create",
        kind: "work",
        id: "W-CANONICAL-PATH",
        title: "Canonical publication path",
        status: "in_progress",
        acceptance: "Published metadata contains only canonical Ledger paths",
        specExemption: true,
      }],
    });
    const stagingPrefix = "runtime/btcc-project-ledger-effects/candidates/";
    const candidateRoot = join(
      butlerData,
      stagingPrefix,
      result.publicationId,
    );
    const canonicalWorkPath =
      `${canonicalPrefix}/work/W-CANONICAL-PATH/work.md`;
    const canonicalFiles = [
      "ledger.jsonl",
      "index/project.json",
      "views/dashboard.md",
      "views/handoff.md",
      "views/roadmap.md",
    ];

    expect(existsSync(candidateRoot)).toBe(false);
    for (const relativePath of canonicalFiles) {
      const content = readFileSync(join(projectRoot, relativePath), "utf8");
      expect(content).not.toContain(stagingPrefix);
      expect(content).not.toContain(candidateRoot);
      if (relativePath.startsWith("views/")) {
        expect(content).toContain(canonicalWorkPath);
      }
    }

    const index = JSON.parse(
      readFileSync(join(projectRoot, "index", "project.json"), "utf8"),
    ) as {
      project: { path: string };
      records: Array<{ id: string; path: string }>;
      views: Array<{
        name: string;
        path: string;
        exists: boolean;
        stale: boolean;
        updatedAt?: string;
      }>;
      index: { path: string };
    };
    expect(index.project.path).toBe(`${canonicalPrefix}/project.json`);
    expect(index.records.find((record) => record.id === "W-CANONICAL-PATH")?.path)
      .toBe(canonicalWorkPath);
    expect(index.views).toEqual([
      {
        name: "dashboard",
        path: `${canonicalPrefix}/views/dashboard.md`,
        exists: true,
        stale: false,
        updatedAt: expect.any(String),
      },
      {
        name: "handoff",
        path: `${canonicalPrefix}/views/handoff.md`,
        exists: true,
        stale: false,
        updatedAt: expect.any(String),
      },
      {
        name: "roadmap",
        path: `${canonicalPrefix}/views/roadmap.md`,
        exists: true,
        stale: false,
        updatedAt: expect.any(String),
      },
    ]);
    expect(index.index.path).toBe(`${canonicalPrefix}/index/project.json`);

    expect(result.promotion).toMatchObject({
      status: "promoted",
      activeHead: { projectRoot },
    });
    expect(result.observation).toMatchObject({
      status: "observed",
      activeHead: { projectRoot },
    });

    const journalPath = join(
      butlerData,
      "runtime",
      "btcc-project-ledger-effects",
      "journals",
      `${result.publicationId}.json`,
    );
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      status: string;
      canonicalRoot: string;
      candidateRoot: string;
    };
    expect(journal).toMatchObject({
      status: "observed",
      canonicalRoot: projectRoot,
      candidateRoot,
    });
  } finally {
    if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
    else process.env.BUTLER_DATA = previousButlerData;
    rmSync(root, { recursive: true, force: true });
  }
});
