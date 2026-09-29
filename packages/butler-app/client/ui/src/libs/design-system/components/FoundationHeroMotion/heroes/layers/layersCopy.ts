import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/** Sample copy of the Layers hero. Token names and numbers never translate. */
export const LAYERS_COPY = {
  en: {
    title: "Layers",
    lead: [
      ["Order", "One named stacking order, from sticky headers to the drag ghost."],
      ["Separation", "Each layer lifts over the one below with its own surface and shadow."],
      ["Depth", "Depth comes from order, dimming and shadow."],
    ] as IntroLead,
    app: "Butler",
    newChat: "New conversation",
    search: "Search",
    favorites: "Favorites",
    favoritesHint: "Pin conversations you visit often.",
    views: "Views",
    all: "All",
    recent: "Recent",
    running: "Running",
    general: "General",
    space: "Space",
    createGroup: "New group",
    menu: "More",
    sessions: ["Launch checklist", "Weekly review", "Release notes draft"],
    settings: "Settings",
    sidebar: "Sidebar",
    showLeft: "Show sidebar",
    sessionActions: "Session actions",
    showRight: "Show right panel",
    ask: "Check the launch checklist every hour?",
    answer: "Sure. I'll set up a schedule that runs every hour:",
    items: ["Review the open items", "Flag anything overdue"],
    worked: "Worked for 4s",
    time: "9:41 AM",
    asked: "9:40 AM",
    done: "Response completed",
    copy: "Copy message",
    copied: "Copied",
    branchChat: "Branch into a new chat",
    branchProject: "Branch into a project",
    more: "Add to message",
    composer: "Ask Butler anything",
    dialogTitle: "New schedule",
    nameLabel: "Title",
    promptLabel: "Prompt",
    prompt: "Review the launch checklist and flag anything overdue.",
    repeatLabel: "Interval",
    intervals: ["10 minutes", "30 minutes", "1 hour", "2 hours", "24 hours", "Custom"],
    cancel: "Cancel",
    create: "Create",
    close: "Close",
    lives: {
      page: "Sidebar, conversation, composer",
      sticky: "Titlebar, sticky headers",
      drawer: "Sidebar drawer (compact)",
      overlay: "The scrim under a dialog",
      dialog: "Dialogs",
      popover: "Menus, selects, popovers",
      tooltip: "Tooltips",
      drag: "The dragged row",
    } as Record<Layer, string>,
  },
  ko: {
    title: "Layers",
    lead: [
      ["순서", "고정 헤더부터 드래그 고스트까지, 이름 붙은 하나의 쌓임 순서."],
      ["분리", "각 층은 자기 표면과 그림자로 아래층 위에 떠오릅니다."],
      ["깊이", "깊이는 순서, 어둡게 하기, 그림자에서 나옵니다."],
    ] as IntroLead,
    app: "Butler",
    newChat: "새 대화",
    search: "검색",
    favorites: "즐겨찾기",
    favoritesHint: "자주 찾는 대화를 고정해 보세요.",
    views: "보기",
    all: "전체보기",
    recent: "최신",
    running: "진행중",
    general: "일반",
    space: "스페이스",
    createGroup: "새 그룹",
    menu: "더 보기",
    sessions: ["출시 체크리스트", "주간 회고", "릴리스 노트 초안"],
    settings: "설정",
    sidebar: "사이드바",
    showLeft: "사이드바 보기",
    sessionActions: "세션 작업",
    showRight: "오른쪽 패널 보기",
    ask: "출시 체크리스트를 매시간 확인해 줄래?",
    answer: "네. 1시간마다 실행되는 예약 작업을 만들게요:",
    items: ["남은 항목 검토", "기한 지난 항목 표시"],
    worked: "4초 동안 작업",
    time: "오전 9:41",
    asked: "오전 9:40",
    done: "응답 완료",
    copy: "메시지 복사",
    copied: "복사됨",
    branchChat: "새 대화로 분기",
    branchProject: "프로젝트로 분기",
    more: "메시지에 추가",
    composer: "Butler에게 무엇이든 물어보세요",
    dialogTitle: "새 예약 작업",
    nameLabel: "제목",
    promptLabel: "프롬프트",
    prompt: "출시 체크리스트를 검토하고 기한이 지난 항목을 표시해 줘.",
    repeatLabel: "간격",
    // The product lists its intervals in English in every locale (AutomationForm).
    intervals: ["10 minutes", "30 minutes", "1 hour", "2 hours", "24 hours", "직접 지정"],
    cancel: "취소",
    create: "만들기",
    close: "닫기",
    lives: {
      page: "사이드바, 대화, 입력창",
      sticky: "타이틀바, 고정 헤더",
      drawer: "사이드바 서랍 (좁은 화면)",
      overlay: "대화상자 아래 스크림",
      dialog: "대화상자",
      popover: "메뉴, 선택 목록, 팝오버",
      tooltip: "툴팁",
      drag: "끌고 있는 행",
    } as Record<Layer, string>,
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type LayersCopy = (typeof LAYERS_COPY)["en"];

/** Every layer of the stacking order, low to high: the page, then each z token. */
export const LAYERS = ["page", "sticky", "drawer", "overlay", "dialog", "popover", "tooltip", "drag"] as const;
export type Layer = (typeof LAYERS)[number];

/** The sheets the screen separates into (the layers it has open), low to high. */
export const SHEETS = ["page", "sticky", "overlay", "dialog", "popover", "tooltip"] as const satisfies readonly Layer[];
export type Sheet = (typeof SHEETS)[number];

/** The selected interval of the open select (its item lines up with the trigger). */
export const PICKED = 2;

/** A layer's token name (the page has none) and live value (read from tokens.css). */
export function zToken(layer: Layer): string {
  return layer === "page" ? "page" : `--z-${layer}`;
}

export function zValue(layer: Layer): string {
  if (layer === "page") return "auto";
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(`--z-${layer}`).trim();
}
