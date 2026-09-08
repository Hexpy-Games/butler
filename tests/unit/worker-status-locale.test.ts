import { afterEach, expect, test } from "bun:test";
import { projectStewardWorkerActivity } from "../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer-worker.ts";
import type { StewardObserverSnapshot } from "../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer.ts";
import { setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { workerActivityStatusLine } from "../../packages/butler-app/client/ui/src/app/utils.ts";
import { planLanes, planBoardTabs, projectDocumentPickerFilters, projectDocumentMarkdownView } from "../../packages/butler-app/client/ui/src/app/projectDocuments.ts";

afterEach(() => setAppCopyLanguage("en"));

const relation = { relation_id: "relation", parent_session_id: "parent", parent_turn_id: "parent-turn",
  child_session_id: "worker", anchor_message_id: "anchor", ordinal: 1, safe_title: "Implement", created_at: "2026-09-08T00:00:00Z" };

function snapshot(state = "admitted"): StewardObserverSnapshot {
  return { session_id: "worker", title: "Implement", turns: [{ id: "turn", state,
    created_at: relation.created_at, updated_at: relation.created_at }], messages: [], progress_events: [],
  plan: null, result: null, updated_at: relation.created_at };
}

test("worker status follows interface locale after projection, not response language or stored text", () => {
  const pending = projectStewardWorkerActivity(relation, snapshot("waiting_for_form"), null);
  setAppCopyLanguage("en");
  expect(workerActivityStatusLine(pending)).toBe("Awaiting approval");
  setAppCopyLanguage("ko");
  expect(workerActivityStatusLine(pending)).toBe("허용 대기 중");
  const recoverable = snapshot();
  recoverable.turns[0]!.recovery = { state: "recoverable" };
  expect(workerActivityStatusLine(projectStewardWorkerActivity(relation, recoverable, null))).toBe("이어서 진행 가능");
  const worker = projectStewardWorkerActivity(relation, snapshot(), null);
  const authored = { ...worker, current_activity_title: "구현 결과를 검증합니다", current_activity_reference: undefined };
  setAppCopyLanguage("en");
  expect(workerActivityStatusLine(authored)).toBe("구현 결과를 검증합니다");
  const generated = { ...worker, current_activity_reference: { key: "toolTitle" as const, parameters: { toolName: "read_file", target: "README.md" } } };
  expect(workerActivityStatusLine(generated)).toBe("Read file: README.md");
  setAppCopyLanguage("ko");
  expect(workerActivityStatusLine(generated)).toBe("파일 읽기: README.md");
  expect(workerActivityStatusLine({ ...worker, terminal: true, status_reference: { key: "workerStatus", parameters: { phase: "complete" } } })).toBe("완료");
});

test("document controls and metadata resolve locale at render time while preserving document values", () => {
  const markdown = "---\nstatus: active\nowner: 연우\n---\n# Authored";
  setAppCopyLanguage("en");
  expect(planLanes()[1].label).toBe("Active");
  expect(projectDocumentMarkdownView(markdown).frontmatter[1]).toEqual({ key: "owner", label: "Owner", value: "연우" });
  setAppCopyLanguage("ko");
  expect(planLanes()[1].label).toBe("진행 중");
  expect(planBoardTabs()[0].label).toBe("계획");
  expect(projectDocumentPickerFilters()[2].label).toBe("로드맵");
  expect(projectDocumentMarkdownView(markdown).frontmatter[1]).toEqual({ key: "owner", label: "담당자", value: "연우" });
  expect(projectDocumentMarkdownView(markdown).body).toBe("# Authored");
});
