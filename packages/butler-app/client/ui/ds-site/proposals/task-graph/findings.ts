import type { ProposalLocale } from "./copy";

// Proposal page notes only (not shipped).
export const FINDINGS: Record<ProposalLocale, { title: string; items: string[] }[]> = {
  "en-US": [
    {
      title: "Reused as they are",
      items: [
        "Inspector resize: AdaptiveShell + AdaptivePanelResizeHandle + usePanelResize already drag the inspector edge (min 292px, max = window − sidebar − 320px workspace, arrow keys ±16px, Home/End). The app keeps the width (right_panel_width via useAppBootstrap). No DS gap.",
        "Conversation: SessionObserverDialog, the dialog that opens a delegated session's messages today (openSessionObserver(sessionId)).",
        "Task document: DocumentTile in the detail, ProjectDocumentDialog + DocumentReader to read it.",
        "Summary tab: SummaryPanel unchanged. The graph is a new Tasks tab after Summary.",
      ],
    },
    {
      title: "Data today",
      items: [
        "Delegations are stored per child: parent session, parent turn, child session, ordinal, created time.",
        "A worker packet already stores its plan action key, dependency keys, model and effort; the App projection does not expose them.",
        "The App gets worker_activity: phase, status line, created/updated time, parent turn, session_id. No edges, no model, no start or finish time, no task document.",
        "Live updates: subsession.changed {session_id, child_session_id}, then a refetch.",
      ],
    },
    {
      title: "Missing for implementation",
      items: [
        "GET /sessions/{id}/task-graph: nodes {task_id, title, status, kind, assignee_ordinal, model_display_name, session_id, started_at, finished_at, current_step, blocked_reason, document: {id, revision, title, status, source_label}} and edges {from, to}, with revision and cursor.",
        "session_id per node = the worker's child session, so the existing session dialog opens it.",
        "A task document read: GET /tasks/{id}/document?revision= returning the Task export (goal, done criteria, prerequisites) plus its pinned spec ref, in the ProjectDashboardDocument shape.",
        "Edges from plan dependency keys now, from the Dependency table after the work model.",
        "A live event with the graph revision (work_model.changed) so the tab patches instead of refetching.",
      ],
    },
    {
      title: "Gaps found",
      items: [
        "Card has no running emphasis; the running card relies on its content (spinner, live line).",
        "RollingSwap ignores the viewer's reduced-motion scope (only the OS setting).",
        "Copy: ko interfaceStatus.task is \"Task\" (English) and is the document dialog badge; it should be \"작업\". projectDocumentBadgeLabel falls back to interfaceStatus.work (\"Work\").",
      ],
    },
  ],
  "ko-KR": [
    {
      title: "그대로 다시 쓰는 것",
      items: [
        "인스펙터 너비: AdaptiveShell + AdaptivePanelResizeHandle + usePanelResize가 이미 가장자리 끌기를 지원합니다(최소 292px, 최대 = 창 − 사이드바 − 작업 영역 320px, 화살표 ±16px, Home/End). 앱은 너비를 기억합니다(useAppBootstrap의 right_panel_width). DS 공백 없음.",
        "대화: 지금 위임 대화를 여는 SessionObserverDialog(openSessionObserver(sessionId)).",
        "작업 문서: 상세의 DocumentTile, 읽기는 ProjectDocumentDialog + DocumentReader.",
        "요약 탭: SummaryPanel 그대로. 그래프는 요약 다음의 새 '작업' 탭입니다.",
      ],
    },
    {
      title: "지금 있는 데이터",
      items: [
        "위임마다 부모 대화, 부모 턴, 자식 대화, 순번, 생성 시각이 저장됩니다.",
        "작업자 패킷에는 계획 항목 키, 선행 키, 모델, 추론 강도가 저장되지만 앱 프로젝션에는 나오지 않습니다.",
        "앱이 받는 worker_activity에는 단계, 상태 문구, 생성·갱신 시각, 부모 턴, session_id만 있습니다. 선행 관계, 모델, 시작·종료 시각, 작업 문서가 없습니다.",
        "실시간: subsession.changed {session_id, child_session_id} 뒤에 다시 받습니다.",
      ],
    },
    {
      title: "구현에 필요한 것",
      items: [
        "GET /sessions/{id}/task-graph: 노드 {task_id, 제목, 상태, 종류, 작업자 순번, 모델 표시 이름, session_id, 시작·종료 시각, 현재 단계, 보류 이유, 문서 {id, revision, 제목, 상태, 출처 라벨}}와 간선 {from, to}, revision과 cursor.",
        "노드마다 session_id = 작업자의 자식 대화. 기존 대화 창이 그대로 엽니다.",
        "작업 문서 읽기: GET /tasks/{id}/document?revision= — 작업 내보내기(목표, 완료 기준, 선행 작업)와 고정된 스펙 참조를 ProjectDashboardDocument 형태로.",
        "간선은 지금은 계획의 선행 키에서, 작업 모델 이후에는 Dependency 테이블에서.",
        "그래프 revision을 담은 실시간 이벤트(work_model.changed)로 다시 받지 않고 바뀐 부분만 반영.",
      ],
    },
    {
      title: "찾은 공백",
      items: [
        "Card에 진행 중 강조 상태가 없어 진행 중 카드는 내용(스피너, 현재 단계 줄)으로만 구분합니다.",
        "RollingSwap이 뷰어의 모션 줄이기 범위를 무시하고 OS 설정만 봅니다.",
        "문구: ko interfaceStatus.task가 \"Task\"(영어)이고 문서 창 배지로 보입니다. \"작업\"이어야 합니다. projectDocumentBadgeLabel의 기본값이 interfaceStatus.work(\"Work\")입니다.",
      ],
    },
  ],
};
