import type { ProposalLocale } from "./fixture";
import type { ProposalComposerCopy } from "./ProposalComposer";

// Proposal page text only. Composer controls and menus read the product copy (appCopy) as they are.

interface PageCopy {
  eyebrow: string;
  title: string;
  intro: string;
  variant: string;
  variants: { split: string; cluster: string; row: string };
  recommended: string;
  width: string;
  widths: { desktop: string; "768": string; "375": string };
  theme: string;
  themes: { light: string; dark: string };
  wallpaper: string;
  wallpapers: { clouds: string; daisies: string; bloom: string; none: string };
  state: string;
  modes: { idle: string; typing: string; streaming: string; folded: string };
  plan: string;
  question: string;
  attachment: string;
  language: string;
  frameLabel: string;
  notesTitle: string;
  notes: { split: string; cluster: string; row: string };
  composer: ProposalComposerCopy;
}

export const PAGE_COPY: Record<ProposalLocale, PageCopy> = {
  "en-US": {
    eyebrow: "Proposal · #473",
    title: "Composer controls",
    intro: "The composer card stays as it is. Only its bottom control row moves into the space below the card; send and stop stay in the card. Every control is a glass pill and the row never wraps.",
    variant: "Variant",
    variants: { split: "A · Split", cluster: "B · Cluster", row: "C · Send row" },
    recommended: "Recommended",
    width: "Width",
    widths: { desktop: "Desktop", "768": "768", "375": "375" },
    theme: "Theme",
    themes: { light: "Light", dark: "Dark" },
    wallpaper: "Wallpaper",
    wallpapers: { clouds: "Clouds (photo)", daisies: "Daisies (photo)", bloom: "Bloom", none: "None" },
    state: "State",
    modes: { idle: "Idle", typing: "Typing", streaming: "Streaming", folded: "Folded" },
    plan: "Plan on",
    question: "Question",
    attachment: "Attachment",
    language: "Language",
    frameLabel: "Composer preview",
    notesTitle: "Variants",
    notes: {
      split: "The row spans the card width with today's grouping: attach, access, workspace and Plan on the left; context and model on the right. Send sits at the bottom right inside the card, next to the last text line.",
      cluster: "Same controls and order packed to the left, no spacer. Shorter pointer travel but model and context lose their fixed right position.",
      row: "The card keeps its toolbar row with only send/stop. Smallest change inside the card, but the card keeps a mostly empty row and divider.",
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
    intro: "컴포저 카드는 그대로 둡니다. 카드 아래쪽 컨트롤 줄만 카드 바로 아래 빈 공간으로 옮기고, 보내기와 중지 버튼은 카드 안에 남깁니다. 컨트롤마다 글래스 필을 쓰고 줄은 한 줄로 유지합니다.",
    variant: "안",
    variants: { split: "A · 양쪽 정렬", cluster: "B · 왼쪽 모음", row: "C · 보내기 줄 유지" },
    recommended: "추천",
    width: "너비",
    widths: { desktop: "데스크톱", "768": "768", "375": "375" },
    theme: "테마",
    themes: { light: "라이트", dark: "다크" },
    wallpaper: "배경화면",
    wallpapers: { clouds: "구름 (사진)", daisies: "데이지 (사진)", bloom: "블룸", none: "없음" },
    state: "상태",
    modes: { idle: "대기", typing: "입력 중", streaming: "응답 중", folded: "접힘" },
    plan: "계획 켜짐",
    question: "질문",
    attachment: "첨부",
    language: "언어",
    frameLabel: "컴포저 미리보기",
    notesTitle: "안 비교",
    notes: {
      split: "줄 너비를 카드에 맞추고 지금의 묶음을 그대로 둡니다. 왼쪽은 첨부, 권한, 작업 공간, 계획, 오른쪽은 컨텍스트와 모델입니다. 보내기는 카드 안 오른쪽 아래, 마지막 줄 옆에 둡니다.",
      cluster: "같은 컨트롤을 같은 순서로 왼쪽에 모읍니다. 이동 거리는 짧지만 모델과 컨텍스트가 오른쪽 고정 위치를 잃습니다.",
      row: "카드 안 툴바 줄을 남기고 보내기·중지만 둡니다. 카드 변경이 가장 적지만 거의 빈 줄과 구분선이 남습니다.",
    },
    composer: {
      controls: "입력 옵션",
      questionHeader: "저장 위치",
      questionText: "초안을 어디에 저장할까요?",
      questionOptions: ["프로젝트", "로컬"],
    },
  },
};
