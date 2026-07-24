import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true });
});

describe("BTCC no-ledger executable routes", () => {
  test.each([
    ["direct-greeting", "direct", 1, 0],
    ["direct-translation", "direct", 1, 0],
    ["assisted-weather", "assisted", 3, 1],
    ["assisted-research", "assisted", 4, 2],
  ] as const)("completes %s without managed records", async (
    scenario,
    expectedRoute,
    expectedModelCalls,
    expectedOperationCalls,
  ) => {
    const dataRoot = mkdtempSync(join(tmpdir(), `butler-btcc-${scenario}-`));
    temporaryRoots.push(dataRoot);
    const harness = resolve(
      import.meta.dir,
      "../../packages/butler-agent/src/interfaces/btcc-harness/run-btcc-harness.ts",
    );
    const child = Bun.spawn([
      process.execPath, "run", harness,
      "--data", dataRoot,
      "--turn", `turn-${scenario}`,
      "--session", `session-${scenario}`,
      "--message", messageFor(scenario),
      "--provider", "harness",
      "--model", "no-ledger-v1",
      "--effort", "medium",
      "--profile-ref", "profile:concise-korean",
      "--feedback-ref", "feedback:lead-with-result",
      "--hot-cache-ref", "cache:avoid-unnecessary-ledger",
      "--observation-scope", "public-current-information",
      "--scenario", scenario,
      "--replay",
    ], {
      cwd: resolve(import.meta.dir, "../.."),
      stderr: "pipe",
      stdout: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout.trim()) as {
      initial: { kind: string; messageId: string; content: string };
      replay: { kind: string; messageId: string; content: string };
      modelCalls: number;
      operationCalls: number;
      phases: string[];
      selectedModel: { provider: string; model: string; reasoningEffort: string };
    };
    expect(result.initial.kind).toBe("delivered");
    expect(result.replay).toEqual(result.initial);
    expect(result.modelCalls).toBe(expectedModelCalls);
    expect(result.operationCalls).toBe(expectedOperationCalls);
    expect(result.phases).toEqual(expectedRoute === "assisted"
      ? [
          "conception_opening",
          ...Array.from({ length: expectedModelCalls - 1 }, () => "assisted_answer"),
        ]
      : ["conception_opening"]);
    expect(result.selectedModel).toEqual({
      provider: "harness",
      model: "no-ledger-v1",
      reasoningEffort: "medium",
    });

    const db = new Database(join(dataRoot, "runtime", "btcc-successor.sqlite"), {
      readonly: true,
    });
    try {
      const turn = db.query<{ route: string; semantic_state: string }, []>(
        "SELECT route, semantic_state FROM btcc_turns",
      ).get();
      const programs = count(db, "btcc_programs");
      const works = count(db, "btcc_work_items");
      const tasks = count(db, "btcc_tasks");
      const operations = count(db, "btcc_phase_operation_result_links");
      const openingProjections = count(db, "btcc_opening_projections");
      const opening = db.query<{ content_json: string }, []>(
        "SELECT content_json FROM btcc_records WHERE kind = 'output_draft'",
      ).get();
      const openingCheckpoint = db.query<{ accepted_product_json: string }, []>(
        `SELECT accepted_product_json FROM btcc_checkpoints
         WHERE semantic_state = 'conception_opening'`,
      ).get();
      const operationRows = db.query<{ projection_json: string }, []>(
        "SELECT projection_json FROM btcc_phase_operation_result_links ORDER BY rowid",
      ).all();
      const draft = JSON.parse(opening!.content_json) as {
        personalizationApplications: Array<{ ref: string }>;
        publicClaims: Array<{ sourceRefs: Array<{ id: string; sha256: string }> }>;
      };

      expect(turn).toEqual({ route: expectedRoute, semantic_state: "delivered" });
      expect(JSON.parse(openingCheckpoint!.accepted_product_json).fulfillment)
        .toEqual({
          requestObligation: requestObligationFor(scenario),
          completionMode: expectedRoute === "assisted"
            ? "bounded_observation_then_answer"
            : "answer_only",
        });
      expect({ programs, works, tasks }).toEqual({ programs: 0, works: 0, tasks: 0 });
      expect(operations).toBe(expectedOperationCalls);
      expect(openingProjections).toBe(expectedRoute === "assisted" ? 1 : 0);
      expect(draft.personalizationApplications.map(({ ref }) => ref)).toEqual([
        "profile:concise-korean",
        "feedback:lead-with-result",
        "cache:avoid-unnecessary-ledger",
      ]);
      const observedRefs = operationRows.map(({ projection_json }) =>
        (JSON.parse(projection_json) as {
          observationRef: { id: string; sha256: string };
        }).observationRef,
      );
      expect(draft.publicClaims.flatMap(({ sourceRefs }) => sourceRefs)).toEqual(observedRefs);
    } finally {
      db.close();
    }
  });
});

function count(db: Database, table: string): number {
  return db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count;
}

function messageFor(scenario: string): string {
  switch (scenario) {
    case "direct-greeting": return "안녕?";
    case "direct-translation": return "이 문장을 영어로 번역해줘: 좋은 아침입니다.";
    case "assisted-weather": return "현재 서울 날씨를 확인해줘.";
    default: return "요즘 유행하는 밈 두 가지를 찾아서 짧게 알려줘.";
  }
}

function requestObligationFor(scenario: string): string {
  switch (scenario) {
    case "direct-greeting": return "개인화된 인사말을 전달한다";
    case "direct-translation": return "정확한 영어 번역문을 전달한다";
    case "assisted-weather": return "관찰한 현재 서울 날씨를 전달한다";
    default: return "관찰한 밈 두 가지를 짧게 전달한다";
  }
}
