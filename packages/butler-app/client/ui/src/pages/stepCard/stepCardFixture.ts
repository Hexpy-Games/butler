import { HARNESS_SS03_OBSERVER_VIEW, HARNESS_STEWARD_CHILD } from "@/app/fixtures";
import type { ProgressRow, SessionView, SessionViewTurn, WorkerActivitySummary } from "@/app/types";
import type { AnchoredStewardProgress } from "@/components/conversation/stewardParentProgressProjection";

export type ActionRow = ProgressRow & { action_key?: string | null };
export interface StepAction {
  action_key: string;
  order: number;
  title: string;
  purpose: string;
  status: "done" | "running" | "pending" | "failed";
  started_at?: string;
  finished_at?: string;
  added_in_revision: number;
}
export interface StepPlan {
  revision: number;
  actions: StepAction[];
  revisions: Array<{ revision: number; at: string; added: string[]; removed: string[]; reason: string }>;
}
export const at = (time: string) => `2026-11-02T${time}:00+09:00`;
const specs = "artifacts/generated/120mm-fan-official-specs.md";
const page = "artifacts/generated/fan-compare-120mm.html";
const models = "Arctic P12 PWM PST, Noctua NF-P12 redux-1700, be quiet! Pure Wings 3, Thermalright TL-C12C, DeepCool FK120, Lian Li UNI FAN P28";
type Tool = [name: string, input: string, time?: string];
interface Stage {
  id: string; action: string | null; time: string; title: string; summary: string;
  phase?: string; next?: string; tools?: Tool[];
}

function plan(finished: boolean): StepPlan {
  const definitions = [
    ["공식 스펙 확인", "아틱 P12와 비교할 5종을 고르고 제조사 공식 페이지에서 스펙을 확인합니다.", "15:49", "15:51"],
    ["국내 최저가 확인", "확정된 6종의 국내 판매가와 판매처를 확인합니다. 스펙은 다시 조사하지 않습니다.", "15:51", "15:57"],
    ["비교 페이지 제작", "스펙과 가격을 비교표와 제품 카드 한 페이지로 정리해 게시합니다.", "15:57", "16:05"],
    ["be quiet 구매 모델 확정", "국내에서 살 수 있는 be quiet 120mm 모델로 바꿔 스펙과 가격을 확정합니다.", "16:00", "16:04"],
  ];
  return { revision: 2, actions: definitions.map(([title, purpose, start, end], index) => ({
    action_key: `a${index + 1}`, order: index + 1, title: title!, purpose: purpose!,
    status: finished || index < 2 ? "done" : "running", started_at: at(start!),
    finished_at: finished || index < 2 ? at(end!) : undefined, added_in_revision: index === 3 ? 2 : 1,
  })), revisions: [{ revision: 2, at: at("16:00"), added: ["a4"], removed: [], reason: "Silent Wings 4 국내 판매 종료" }] };
}

function stages(finished: boolean): Stage[] {
  const entries: Stage[] = [
    { id: "request", action: null, time: "15:47", title: "요청 내용 확인", phase: "conception",
      summary: "ARCTIC 120mm 팬을 기준으로 경쟁 제품과 국내 최저가를 함께 비교합니다.", next: "비교 범위와 확인 순서를 정합니다." },
    { id: "plan", action: null, time: "15:48", title: "실행 계획 수립", phase: "planning",
      summary: "공식 스펙 확인, 국내 판매가 조사, 비교 페이지 제작 순서로 진행합니다.", next: "비교 후보 6종을 확정합니다." },
    { id: "candidates", action: "a1", time: "15:49", title: "비교 후보 선정", summary: models,
      tools: [["web_search", "Arctic P12 PWM PST 경쟁 120mm 팬"], ["web_search", "120mm 케이스팬 추천 2026"], ["web_read", "quasarzone.com"]] },
    { id: "official", action: "a1", time: "15:50", title: "제조사 공식 스펙 수집",
      summary: "두 Worker가 제조사 공식 페이지에서 회전수, 풍량, 소음과 연결 방식을 나눠 확인했습니다.",
      next: "같은 기준으로 스펙 비교표를 작성합니다.", tools: [["delegate_to_worker", "arctic·noctua·be quiet 공식 스펙"], ["delegate_to_worker", "thermalright·deepcool·lian li 공식 스펙"]] },
    { id: "specs", action: "a1", time: "15:51", title: "스펙 비교표 작성", summary: "6종 공식 스펙 비교표를 만들었습니다 · 120mm-fan-official-specs.md",
      tools: [["write_file", specs], ["deliver_files", specs]] },
    { id: "prices", action: "a2", time: "15:52", title: "판매가 조회", summary: "다나와, 컴퓨존, 11번가, 쿠팡에서 국내 판매가와 재고를 확인했습니다.",
      tools: [["web_search", "아틱 P12 PWM PST 최저가"], ["web_search", "녹투아 NF-P12 redux 가격"], ["web_search", "be quiet Pure Wings 3 120mm PWM 국내"],
        ...["danawa.com", "compuzone.co.kr", "11st.co.kr", "coupang.com"].map((shop): Tool => ["web_read", shop])] },
    { id: "price-basis", action: "a2", time: "15:57", title: "가격 기준 정리", phase: "task_review",
      summary: "6종 중 4종은 판매처 페이지에서 표시가를 확인했고, 2종은 가격비교 기준입니다.",
      next: "배송비와 조회 기준을 비교표에 함께 표시합니다.", tools: [["edit_file", specs]] },
    { id: "page-start", action: "a3", time: "15:57", title: "비교 페이지 구성", summary: "스펙과 가격을 비교표와 제품 카드로 구성했습니다.",
      next: "390px 화면에서 표와 카드 배치를 확인합니다.", tools: [["write_file", page, "15:58"],
        ["browser_open", page, "16:01"], ["browser_observe", "390px 화면", "16:01"]] },
    { id: "replacement", action: "a4", time: "16:00", title: "대체 모델 확인", summary: "컴퓨존에서 Pure Wings 3 PWM (BL094)의 재고와 표시가를 확인하고 있습니다.",
      next: "구매 모델과 최종 가격을 비교 페이지에 반영합니다.", tools: [["web_search", "be quiet Pure Wings 3 120mm PWM 국내", "16:00"],
        ["web_read", "compuzone.co.kr", "16:02"]] },
  ];
  if (finished) entries.push(
    { id: "confirmed", action: "a4", time: "16:04", title: "구매 모델 확정", phase: "task_review", summary: "Pure Wings 3 PWM (BL094) 39,500원 · 컴퓨존" },
    { id: "publish", action: "a3", time: "16:05", title: "결과물 게시", summary: "비교 페이지를 게시했습니다 · fan-compare-120mm.html",
      tools: [["output_publish", page], ["deliver_files", page]] },
    { id: "review", action: null, time: "16:06", title: "결과 검토", phase: "task_review",
      summary: "6종의 공식 스펙, 국내 가격과 구매처를 확인하고 비교 페이지의 링크와 화면을 검토했습니다." },
  );
  return entries;
}

function stageRows(stage: Stage, finished: boolean): ActionRow[] {
  const running = !finished && stage.id === "replacement";
  return [{ id: stage.id, kind: "message", safe_label: stage.title, state: running ? "running" : "delivered",
    action_key: stage.action, semantic_block_id: stage.id, work_decision_source: "model-authored",
    work_decision_title: stage.title, work_decision_summary: stage.summary, work_decision_next_step: stage.next,
    activity_stage: stage.phase ?? "execution", created_at: at(stage.time) },
  ...(stage.tools ?? []).map(([name, input, time], index): ActionRow => ({
    id: `${stage.id}-tool-${index}`, kind: "used_tool", state: running && index === (stage.tools?.length ?? 0) - 1 ? "running" : "delivered",
    safe_label: name, safe_tool_name: name, safe_input_label: input, tool_call_id: `${stage.id}-call-${index}`,
    bridge_phase: "btcc_operation", semantic_block_id: stage.id, created_at: at(time ?? stage.time),
  }))];
}

function workers(): WorkerActivitySummary[] {
  return ["arctic·noctua·be quiet 공식 스펙", "thermalright·deepcool·lian li 공식 스펙"].map((objective, index) => ({
    worker_id: `spec-worker-${index}`, worker_label: `Worker ${index + 1}`, worker_display_name: `Worker ${index + 1}`,
    objective, phase: "complete", status_line: "공식 스펙 확인 완료", terminal: true,
    parent_turn_id: "turn-official", source_tool_call_id: `official-call-${index}`, supported_controls: [],
  }));
}

export function stepCardFixture(finished: boolean): { plan: StepPlan; view: SessionView; progress: AnchoredStewardProgress } {
  const entries = stages(finished);
  // continue_work turns retain earlier stages; the active turn interleaves parallel actions.
  const history = entries.filter(stage => finished || !["a3", "a4"].includes(stage.action ?? "")).map(stage => ({
    turn_id: `turn-${stage.id}`, created_at: at(stage.time), rows: stageRows(stage, finished),
  }));
  const latest = entries.at(-1)!;
  const rows = finished ? stageRows(latest, true) : entries.filter(stage => ["a3", "a4"].includes(stage.action ?? "")).flatMap(stage => stageRows(stage, false))
    .sort((left, right) => (left.created_at ?? "").localeCompare(right.created_at ?? ""));
  const turn: SessionViewTurn = { ...HARNESS_STEWARD_CHILD.latest_turn!, id: finished ? `turn-${latest.id}` : "turn-active",
    state: finished ? "delivered" : "running", cancellable: !finished, retryable: false,
    progress: { safe_progress_rows: rows }, created_at: at(finished ? latest.time : "15:57"), updated_at: at(finished ? latest.time : "16:02") };
  const child = { ...HARNESS_STEWARD_CHILD, session_id: "step-card-child", title: "ARCTIC 120mm 팬 경쟁 제품 비교 및 최저가 조사",
    status: finished ? "delivered" as const : "active" as const, terminal: finished, active_turn: finished ? null : turn, latest_turn: turn,
    approved_plan_revision: 2, approved_plan_total: 4, approved_plan_completed: finished ? 4 : 2,
    relation: { ...HARNESS_STEWARD_CHILD.relation, child_session_id: "step-card-child" },
    result: finished ? { result_id: "fan-result", relation_id: HARNESS_STEWARD_CHILD.relation.relation_id,
      task_id: "fan-compare", child_session_id: "step-card-child", child_turn_id: turn.id, status: "success" as const,
      code: null, summary: "비교 페이지를 게시했습니다.", acceptance_evidence: [], changed_artifacts: [], created_at: at("16:06") } : null };
  const view: SessionView = { ...HARNESS_SS03_OBSERVER_VIEW, session_id: child.session_id, status: child.status,
    active_turn: child.active_turn, latest_turn: turn, activity_history: history, messages: [], workers: workers(),
    approved_plan_total: 4, approved_plan_completed: child.approved_plan_completed, approved_plan_revision: 2,
    artifacts: [], steward_children: [], relation: child.relation };
  return { plan: plan(finished), view, progress: { child, turn, rows } };
}
