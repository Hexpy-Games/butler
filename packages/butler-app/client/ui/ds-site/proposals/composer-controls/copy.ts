import type { ProposalLocale } from "./fixture";
import type { ProposalComposerCopy } from "./ProposalComposer";

// Proposal page text only. Composer controls and menus read the product copy (appCopy) as they are.

interface PageCopy {
  eyebrow: string;
  title: string;
  intro: string;
  variant: string;
  variants: { split: string; cluster: string };
  recommended: string;
  width: string;
  widths: { desktop: string; "768": string; "375": string };
  theme: string;
  themes: { light: string; dark: string };
  wallpaper: string;
  wallpapers: { clouds: string; daisies: string; bloom: string; none: string };
  state: string;
  modes: { idle: string; typing: string; streaming: string };
  plan: string;
  question: string;
  attachment: string;
  language: string;
  frameLabel: string;
  notesTitle: string;
  notes: { split: string; cluster: string };
  composer: ProposalComposerCopy;
}

export const PAGE_COPY: Record<ProposalLocale, PageCopy> = {
  "en-US": {
    eyebrow: "Proposal · #473",
    title: "Composer controls",
    intro: "The composer card stays exactly as it ships today. Only its controls move into the space below the card; send and stop stay where they are. Every control is a glass pill and the row never wraps.",
    variant: "Variant",
    variants: { split: "A · Split", cluster: "B · Cluster" },
    recommended: "Recommended",
    width: "Width",
    widths: { desktop: "Desktop", "768": "768", "375": "375" },
    theme: "Theme",
    themes: { light: "Light", dark: "Dark" },
    wallpaper: "Wallpaper",
    wallpapers: { clouds: "Clouds (photo)", daisies: "Daisies (photo)", bloom: "Bloom", none: "None" },
    state: "State",
    modes: { idle: "Idle", typing: "Typing", streaming: "Streaming" },
    plan: "Plan on",
    question: "Question",
    attachment: "Attachment",
    language: "Language",
    frameLabel: "Composer preview",
    notesTitle: "Variants",
    notes: {
      split: "The row spans exactly the card width with today's grouping: attach, access, workspace and Plan start on the card's left edge; context and model end on its right edge.",
      cluster: "Same controls and order packed to the left, no spacer. Shorter pointer travel but model and context lose their fixed right position.",
    },
    composer: {
      controls: "Composer controls",
      questionHeader: "Destination",
      questionText: "Where should I save the draft?",
      questionOptions: ["Project", "Local"],
    },
  },
  "ko-KR": {
    eyebrow: "제안 · #473",
    title: "컴포저 컨트롤",
    intro: "컴포저 카드는 지금 앱과 똑같이 둡니다. 컨트롤만 카드 바로 아래 빈 공간으로 옮기고, 보내기와 중지 버튼은 지금 자리에 그대로 둡니다. 컨트롤마다 글래스 필을 쓰고 줄은 한 줄로 유지합니다.",
    variant: "안",
    variants: { split: "A · 양쪽 정렬", cluster: "B · 왼쪽 모음" },
    recommended: "추천",
    width: "너비",
    widths: { desktop: "데스크톱", "768": "768", "375": "375" },
    theme: "테마",
    themes: { light: "라이트", dark: "다크" },
    wallpaper: "배경화면",
    wallpapers: { clouds: "구름 (사진)", daisies: "데이지 (사진)", bloom: "블룸", none: "없음" },
    state: "상태",
    modes: { idle: "대기", typing: "입력 중", streaming: "응답 중" },
    plan: "계획 켜짐",
    question: "질문",
    attachment: "첨부",
    language: "언어",
    frameLabel: "컴포저 미리보기",
    notesTitle: "안 비교",
    notes: {
      split: "줄 너비를 카드와 정확히 맞추고 지금의 묶음을 그대로 둡니다. 첨부, 권한, 작업 공간, 계획은 카드 왼쪽 끝에서 시작하고, 컨텍스트와 모델은 카드 오른쪽 끝에서 끝납니다.",
      cluster: "같은 컨트롤을 같은 순서로 왼쪽에 모읍니다. 이동 거리는 짧지만 모델과 컨텍스트가 오른쪽 고정 위치를 잃습니다.",
    },
    composer: {
      controls: "입력 옵션",
      questionHeader: "저장 위치",
      questionText: "초안을 어디에 저장할까요?",
      questionOptions: ["프로젝트", "로컬"],
    },
  },
};
