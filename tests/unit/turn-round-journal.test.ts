import { expect, test } from "bun:test";
import {
  buildTurnRoundJournal,
  renderTurnRoundJournal,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-round-journal.ts";

test("round journal retains generic Project Ledger state without raw bodies", () => {
  const entries = buildTurnRoundJournal({
    audit: [{
      name: "project_ledger_status",
      args: {},
      ok: true,
      result: {
        ok: true,
        command: "project-ledger status",
        data: {
          project: { id: "sandy-bot", status: "active" },
          issueCount: 0,
          generatedAt: "2026-07-10T00:00:00.000Z",
          nextActions: [],
          body: "private source body must not enter the journal",
        },
      },
    }],
    publicDecisions: [{
      decisionId: "decision-ledger-status",
      semanticBlockId: "contract-a:block:0",
      blockTitle: "Ledger 기준점 확인",
      summary: "현재 Ledger 기준점을 확인합니다.",
      rationale: "부재를 확인한 뒤 mutation으로 전진해야 합니다.",
      nextStep: "요청 레코드가 없으면 생성합니다.",
      expectedEffect: "요청 레코드의 존재 여부와 revision을 확인합니다.",
      repeatReason: "race_confirmation",
      evidenceRefs: [],
      source: "model-authored",
      toolName: "project_ledger_status",
    }],
  });

  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    decision_id: "decision-ledger-status",
    semantic_block_id: "contract-a:block:0",
    block_title: "Ledger 기준점 확인",
    expected_effect: "요청 레코드의 존재 여부와 revision을 확인합니다.",
    repeat_reason: "race_confirmation",
    tool: "project_ledger_status",
    observed_delta: "none",
  });
  expect(entries[0]!.result_preview).toMatchObject({
    tool_name: "project_ledger_status",
    ok: true,
    command: "project-ledger status",
  });
  expect(JSON.stringify(entries)).not.toContain("private source body");
});

test("round journal fingerprints ignore volatile timestamps but distinguish mutation", () => {
  const read = (generatedAt: string) => buildTurnRoundJournal({
    audit: [{
      name: "project_ledger_status",
      args: {},
      ok: true,
      result: { ok: true, data: { issueCount: 0, generatedAt } },
    }],
    publicDecisions: [],
  })[0]!;
  const first = read("2026-07-10T00:00:00.000Z");
  const second = read("2026-07-10T00:01:00.000Z");
  const mutation = buildTurnRoundJournal({
    audit: [{
      name: "project_ledger_create",
      args: { kind: "spec", id: "SPEC-WEB-CAPTURE" },
      ok: true,
      result: { ok: true, data: { id: "SPEC-WEB-CAPTURE", kind: "spec", status: "specified" } },
    }],
    publicDecisions: [],
  })[0]!;

  expect(first.result_fingerprint).toBe(second.result_fingerprint);
  expect(first.state_revision).toBe(second.state_revision);
  expect(mutation.observed_delta).toBe("mutation");
  expect(mutation.state_revision).not.toBe(first.state_revision);
  expect(renderTurnRoundJournal([first, mutation])).toContain("no-delta broad read");
});
