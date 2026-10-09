import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/**
 * Copy of the Layout hero. The screen strings are the app's own (butler-i18n
 * locales), so the shell reads exactly as Butler does. Token names, numbers
 * and mode names never translate.
 */
export const LAYOUT_COPY = {
  en: {
    title: "Layout",
    lead: [
      ["Shell", "One app shell: a titlebar, a sidebar, the conversation and its composer."],
      ["Modes", "The window's width picks the mode: expanded, medium or compact."],
      ["Platform", "Breakpoints are constants in responsive.ts; below them the sidebar is a drawer."],
    ] as IntroLead,
    app: "Butler", newChat: "New conversation", search: "Search", favorites: "Favorites", favoritesHint: "Pin conversations you visit often.",
    all: "All", recent: "Recent", running: "Running", general: "General", space: "Space", settings: "Settings",
    project: "Design system",
    sessions: ["Migrate spacing tokens to rem", "Audit icon sizes in the sidebar", "Composer jumps on iOS", "Compare focus ring contrast", "Clean up stale feature flags", "Weekly release notes", "Draft the launch week plan"],
    active: 2, local: "Local",
    ask1: "The composer jumps when the keyboard opens on iOS. Can you find out why?",
    answer1: "The composer is pinned to the layout viewport, but Safari only shrinks the visual viewport when the keyboard opens. Two things would fix it:",
    ask2: "Do it, and leave the drawer alone.",
    answer2: "Done. The drawer is untouched, and the composer now follows the keyboard:",
    steps: [["Read the keyboard offset from ", "visualViewport", "."], ["Add one resize listener, removed on unmount.", "", ""]] as Array<[string, string, string]>,
    code: "const vv = visualViewport;\nconst gap = innerHeight - vv.height;\ncomposer.style.bottom = `${gap}px`;",
    worked: "Worked for 9s", time: "9:41 AM", done: "Response completed", placeholder: "Ask Butler anything",
    copy: "Copy message", more: "More options", sidebar: "Show sidebar", hide: "Hide sidebar", panel: "Show right panel",
  },
  ko: {
    title: "Layout",
    lead: [
      ["셸", "하나의 앱 셸: 타이틀바, 사이드바, 대화와 컴포저."],
      ["모드", "창의 너비가 모드를 정합니다: expanded, medium, compact."],
      ["플랫폼", "중단점은 responsive.ts의 상수이고, 그보다 좁으면 사이드바는 서랍이 됩니다."],
    ] as IntroLead,
    app: "Butler", newChat: "새 대화", search: "검색", favorites: "즐겨찾기", favoritesHint: "자주 찾는 대화를 고정해 보세요.",
    all: "전체보기", recent: "최신", running: "진행중", general: "일반", space: "스페이스", settings: "설정",
    project: "디자인 시스템",
    sessions: ["간격 토큰을 rem으로 이전", "사이드바 아이콘 크기 점검", "iOS에서 컴포저가 튀는 문제", "포커스 링 대비 비교", "오래된 기능 플래그 정리", "주간 릴리스 노트", "출시 주간 계획 초안"],
    active: 2, local: "로컬",
    ask1: "iOS에서 키보드가 열리면 컴포저가 튀어. 원인을 찾아 줄래?",
    answer1: "컴포저는 레이아웃 뷰포트에 고정돼 있는데, 키보드가 열리면 Safari는 비주얼 뷰포트만 줄입니다. 두 가지로 해결할 수 있어요:",
    ask2: "그렇게 해 줘. 서랍은 건드리지 말고.",
    answer2: "완료했습니다. 서랍은 그대로이고, 컴포저가 키보드를 따라갑니다:",
    steps: [["키보드 오프셋을 ", "visualViewport", "에서 읽기"], ["리사이즈 리스너 하나 추가, 화면이 사라지면 제거", "", ""]] as Array<[string, string, string]>,
    code: "const vv = visualViewport;\nconst gap = innerHeight - vv.height;\ncomposer.style.bottom = `${gap}px`;",
    worked: "9초 동안 작업", time: "오전 9:41", done: "답변 완료", placeholder: "버틀러에게 무엇이든 물어보세요",
    copy: "메시지 복사", more: "추가 기능", sidebar: "사이드바 보기", hide: "사이드바 숨기기", panel: "오른쪽 패널 보기",
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type LayoutCopy = (typeof LAYOUT_COPY)["en"];

export type Mode = "expanded" | "medium" | "compact";

/**
 * The widths the handle drags the window through (device px), and the mode
 * responsive.ts gives each (compactMax 640, mediumMax 1023, browser chrome).
 */
export const DETENTS = [
  { px: 1280, mode: "expanded" },
  { px: 1023, mode: "medium" },
  { px: 640, mode: "compact" },
  { px: 375, mode: "compact" },
] as const satisfies ReadonlyArray<{ px: number; mode: Mode }>;

export const MODES: Mode[] = ["expanded", "medium", "compact"];

/** Each mode's width range, as responsive.ts classifies it. */
export const RANGES: Record<Mode, string> = { expanded: "≥ 1024", medium: "641 – 1023", compact: "≤ 640" };

/** The window's size at the start of the drag (device px), and the screens' in the poster. */
export const WINDOW = { w: 1280, h: 560 } as const;
export const SCREEN = { expanded: { w: 1024, h: 640 }, medium: { w: 768, h: 640 }, compact: { w: 375, h: 640 } } as const;

/** Canvas px per device px of the window in the drag, per canvas (LayoutHero.module.css --s). */
export const ZOOM = { wide: 0.72, tall: 0.3 } as const;

/** A token's live value from tokens.css, read at render. */
export function tokenValue(token: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}
