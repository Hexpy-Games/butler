import type { FoundationHeroLang } from "../../FoundationHeroMotion";

/** Sample copy of the Typography hero. Role names, token names and numbers never translate. */
export interface TypeCopy {
  latin: string;
  hangul: string;
  stack: string;
  title: string;
  titleLead: string;
  field: string;
  fieldHint: string;
  ask: string;
  answer: string;
  command: string;
  meta: string;
  dash: string;
  metric: string;
  metricLabel: string;
  change: string;
  placeholder: string;
  more: string;
  send: string;
}

export const TYPE_COPY: Record<FoundationHeroLang, TypeCopy> = {
  en: {
    latin: "Latin", hangul: "Hangul", stack: "One stack · Pretendard Variable",
    title: "Appearance", titleLead: "Applies to every window.", field: "Translucent sidebar", fieldHint: "Show the desktop behind it.",
    ask: "What changed this week?", answer: "Three changes landed: the settings rhythm, a new focus ring and Korean line breaks.",
    command: "git log --oneline", meta: "1:25 PM · 2 files",
    dash: "This week", metric: "1,284", metricLabel: "Tasks completed", change: "+12%",
    placeholder: "Ask Butler anything", more: "More", send: "Send",
  },
  ko: {
    latin: "라틴", hangul: "한글", stack: "하나의 스택 · Pretendard Variable",
    title: "화면 설정", titleLead: "모든 창에 적용됩니다.", field: "반투명 사이드바", fieldHint: "사이드바 뒤로 바탕 화면을 비춥니다.",
    ask: "이번 주에 뭐가 바뀌었어요?", answer: "세 가지가 반영됐어요. 설정 간격, 새 포커스 링, 한국어 줄바꿈입니다.",
    command: "git log --oneline", meta: "오후 1:25 · 파일 2개",
    dash: "이번 주", metric: "1,284", metricLabel: "완료한 작업", change: "+12%",
    placeholder: "Butler에게 무엇이든 물어보세요", more: "더 보기", send: "보내기",
  },
};
