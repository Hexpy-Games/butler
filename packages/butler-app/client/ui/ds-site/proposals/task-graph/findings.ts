import type { ProposalLocale } from "./copy";

// Proposal page notes only (not shipped).
export const FINDINGS: Record<ProposalLocale, { title: string; items: string[] }[]> = {
  "en-US": [
    {
      title: "Data today",
      items: [
        "Delegations are stored per child: parent session, parent turn, child session, ordinal, created time (btcc_subsession_delegations).",
        "A worker packet already stores its plan action key and dependency keys, plus model and effort. The App projection does not expose them.",
        "The App gets worker_activity: phase, status line, created/updated time, parent turn. No edges, no model, no start or finish time (updated_at is the creation time).",
        "Live updates: subsession.changed {session_id, child_session_id} on /events/live, then a session-summary refetch.",
      ],
    },
    {
      title: "Missing for implementation",
      items: [
        "A task graph read model: GET /sessions/{id}/task-graph returning nodes (id, title, status, kind, assignee ordinal, model display name, started_at, finished_at, current step) and prerequisite edges, with revision and cursor.",
        "Edges from the plan's dependency keys (now) or the Task Dependency table (work model).",
        "A live event that carries the graph revision (work_model.changed) so the panel patches instead of refetching.",
      ],
    },
    {
      title: "DS gaps",
      items: [
        "Card has no running emphasis; the running card relies on its content (spinner, live line).",
        "WorkerActivityRow phase rail labels are hard-coded English.",
        "RollingSwap ignores the viewer's reduced-motion scope (only the OS setting).",
      ],
    },
  ],
  "ko-KR": [
    {
      title: "지금 있는 데이터",
      items: [
        "위임마다 부모 대화, 부모 턴, 자식 대화, 순번, 생성 시각이 저장됩니다(btcc_subsession_delegations).",
        "작업자 패킷에는 계획 항목 키와 선행 키, 모델과 추론 강도가 이미 저장되지만 앱 프로젝션에는 나오지 않습니다.",
        "앱이 받는 worker_activity에는 단계, 상태 문구, 생성·갱신 시각, 부모 턴만 있습니다. 선행 관계, 모델, 시작·종료 시각이 없습니다(updated_at은 생성 시각).",
        "실시간: /events/live의 subsession.changed {session_id, child_session_id} 뒤에 요약을 다시 받습니다.",
      ],
    },
    {
      title: "구현에 필요한 것",
      items: [
        "작업 그래프 읽기 모델: GET /sessions/{id}/task-graph — 노드(id, 제목, 상태, 종류, 작업자 순번, 모델 표시 이름, 시작·종료 시각, 현재 단계)와 선행 간선, revision과 cursor.",
        "간선은 지금은 계획의 선행 키에서, 작업 모델 이후에는 Dependency 테이블에서 만듭니다.",
        "그래프 revision을 담은 실시간 이벤트(work_model.changed)로 다시 받지 않고 바뀐 부분만 반영합니다.",
      ],
    },
    {
      title: "DS 공백",
      items: [
        "Card에 진행 중 강조 상태가 없어 진행 중 카드는 내용(스피너, 현재 단계 줄)으로만 구분합니다.",
        "WorkerActivityRow 단계 막대 라벨이 영어로 고정되어 있습니다.",
        "RollingSwap이 뷰어의 모션 줄이기 범위를 무시하고 OS 설정만 봅니다.",
      ],
    },
  ],
};
