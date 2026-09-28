import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { LineRole } from "./typeLines";

/** Sample copy of the Typography hero. Role names, token names and numbers never translate. */
export interface TypeCopy {
  title: string;
  titleLead: string;
  field: string;
  fieldHint: string;
  field2: string;
  field2Hint: string;
  ask: string;
  answer: string;
  /** The reply's list: plain text, then an inline code span, then the rest. */
  items: Array<[string, string?, string?]>;
  worked: string;
  time: string;
  branchProject: string;
  done: string;
  copy: string;
  branch: string;
  command: string;
  meta: string;
  dash: string;
  metric: string;
  metricLabel: string;
  change: string;
  metric2: string;
  metric2Label: string;
  change2: string;
  placeholder: string;
  more: string;
  send: string;
  /** Role words on the build badges; the token name beside them stays as is. */
  roles: Record<LineRole, string>;
}

export const TYPE_COPY: Record<FoundationHeroLang, TypeCopy> = {
  en: {
    title: "Appearance", titleLead: "Applies to every window.", field: "Translucent sidebar", fieldHint: "Show the desktop behind it.",
    field2: "Reduce motion", field2Hint: "Fades instead of moving.",
    ask: "What's new this week?", answer: "Two changes landed since Monday:",
    items: [["Settings follow the 4px grid."], ["Hangul breaks by word: ", "keep-all"]],
    time: "1:25 PM", branchProject: "Branch into a project",
    worked: "Worked for 9s", done: "Response completed", copy: "Copy message", branch: "Branch into a new chat",
    command: "git log --oneline", meta: "1:25 PM · 2 files",
    dash: "This week", metric: "1,284", metricLabel: "Tasks completed", change: "+12%",
    metric2: "96%", metric2Label: "On time", change2: "+3%",
    placeholder: "Ask Butler anything", more: "More", send: "Send",
    roles: { heading: "Heading", body: "Body", label: "Label", caption: "Caption", code: "Code", dashboard: "Dashboard title", metric: "Metric" },
  },
  ko: {
    title: "화면 설정", titleLead: "모든 창에 적용됩니다.", field: "반투명 사이드바", fieldHint: "사이드바 뒤로 바탕 화면을 비춥니다.",
    field2: "동작 줄이기", field2Hint: "움직임 대신 페이드로 전환합니다.",
    ask: "이번 주 바뀐 점은?", answer: "월요일 이후 두 가지가 반영됐어요.",
    items: [["설정은 4px 그리드를 따릅니다."], ["한국어는 단어 단위로: ", "keep-all"]],
    time: "오후 1:25", branchProject: "프로젝트로 분기",
    worked: "9초 동안 작업", done: "응답 완료", copy: "메시지 복사", branch: "새 대화로 분기",
    command: "git log --oneline", meta: "오후 1:25 · 파일 2개",
    dash: "이번 주", metric: "1,284", metricLabel: "완료한 작업", change: "+12%",
    metric2: "96%", metric2Label: "제시간 완료", change2: "+3%",
    placeholder: "Butler에게 무엇이든 물어보세요", more: "더 보기", send: "보내기",
    roles: { heading: "제목", body: "본문", label: "레이블", caption: "캡션", code: "코드", dashboard: "대시보드 제목", metric: "지표" },
  },
};
