import type { ComposerQuestion, QuestionPanelLabels } from "./types";
export const koLabels: QuestionPanelLabels = {
  review: "확인", send: "보내기", next: "다음", back: "이전", skip: "건너뛰기", skipped: "건너뜀",
  later: "나중에", pending: "답변 대기", other: "직접 입력…", recommended: "추천", working: "작업 중", select: "선택",
};
export function questionFixtures(ko: boolean) {
  const single: ComposerQuestion = { id: "save", header: ko ? "저장 위치" : "Save location", text: ko ? "어디에 저장할까요?" : "Where should I save it?", type: "single", allowOther: true,
    options: [{ label: ko ? "프로젝트 폴더" : "Project folder", description: "Butler/Notes", recommended: true }, { label: ko ? "바탕화면" : "Desktop" }, { label: ko ? "매번 묻기" : "Ask each time", description: ko ? "저장할 때마다 확인" : "Confirm before saving" }] };
  const multi: ComposerQuestion = { id: "notifications", header: ko ? "알림" : "Notifications", text: ko ? "어떤 알림을 받을까요?" : "Which notifications do you want?", type: "multi", allowOther: true,
    options: (ko ? ["작업 완료", "허용 요청", "예약 작업 결과", "오류", "워커 상태", "업데이트 소식"] : ["Task complete", "Approval request", "Schedule results", "Errors", "Worker status", "Updates"]).map((label, i) => ({ label, recommended: i === 1, description: i < 4 ? (ko ? "상태가 바뀌면 알림" : "Notify when the status changes") : undefined })) };
  const text: ComposerQuestion = { id: "name", header: ko ? "프로젝트 이름" : "Project name", text: ko ? "이름을 정해 주세요" : "Choose a name", type: "text", options: [], placeholder: ko ? "예: 분기 보고서" : "e.g. Quarterly report" };
  const schedule: ComposerQuestion[] = [
    { ...single, id: "frequency", header: ko ? "주기" : "Frequency", text: ko ? "언제 실행할까요?" : "When should it run?", options: (ko ? ["매일 아침 8시", "평일 아침 8시", "매주 월요일 9시"] : ["Daily at 8 am", "Weekdays at 8 am", "Mondays at 9 am"]).map((label, i) => ({ label, recommended: i === 0 })) },
    { ...multi, id: "scope", header: ko ? "범위" : "Scope", text: ko ? "무엇을 요약할까요?" : "What should I summarize?", options: (ko ? ["받은 메일", "캘린더", "메신저 멘션"] : ["Inbox", "Calendar", "Mentions"]).map((label) => ({ label })) },
    { ...single, id: "destination", header: ko ? "받을 곳" : "Destination", text: ko ? "어디로 보낼까요?" : "Where should I send it?" },
  ];
  const onboarding: ComposerQuestion[] = [
    { ...text, header: ko ? "호칭" : "Name", text: ko ? "어떻게 불러 드릴까요?" : "What should I call you?", placeholder: ko ? "이름이나 별명" : "Name or nickname" },
    { ...single, id: "purpose", header: ko ? "주 용도" : "Purpose", text: ko ? "버틀러를 어디에 쓰실 건가요?" : "How will you use Butler?", options: (ko ? ["업무", "개발", "개인"] : ["Work", "Development", "Personal"]).map((label, i) => ({ label, description: ko ? "문서·일정·작업" : "Documents, schedules and tasks", recommended: i === 0 })) },
    { ...single, id: "language", header: ko ? "언어·말투" : "Language", text: ko ? "어떤 말투가 편하세요?" : "Which tone do you prefer?", options: [{ label: ko ? "한국어 · 존댓말" : "Korean · polite", recommended: true }, { label: ko ? "한국어 · 반말" : "Korean · casual" }, { label: "English" }] },
  ];
  return { single: [single], multi: [multi], text: [text], schedule, onboarding, four: [...schedule, text] };
}
