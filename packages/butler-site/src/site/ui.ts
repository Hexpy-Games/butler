/**
 * Site chrome copy per locale: every string the layout shows around the docs
 * content (titlebar, sidebar, search, page chrome, footer, home, 404).
 * Section labels live in sections.ts; page text lives in the MDX.
 */
import type { Locale } from "./sections";

export interface UiCopy {
  /** Name of the language, in that language (switcher tooltip). */
  languageName: string;
  /** Two-letter switcher label. */
  languageCode: string;
  /** The product label beside the wordmark. */
  product: string;
  skipToContent: string;
  menu: string;
  closeMenu: string;
  sidebar: string;
  docs: string;
  breadcrumb: string;
  language: string;
  githubRepository: string;
  theme: { label: string; system: string; light: string; dark: string };
  search: {
    button: string;
    label: string;
    move: string;
    open: string;
    close: string;
    loading: string;
    empty: string;
    unavailable: string;
  };
  planned: { badge: string; reason: string; card: string };
  page: { toc: string; previous: string; next: string; pager: string; copyCode: string };
  footer: { status: string; designSystem: string; releases: string };
  home: { title: string; description: string };
  notFound: { title: string; description: string; home: string };
}

export const UI: Record<Locale, UiCopy> = {
  ko: {
    languageName: "한국어",
    languageCode: "KO",
    product: "사용 설명서",
    skipToContent: "본문으로 건너뛰기",
    menu: "메뉴",
    closeMenu: "메뉴 닫기",
    sidebar: "문서 탐색",
    docs: "문서",
    breadcrumb: "현재 위치",
    language: "언어",
    githubRepository: "GitHub 저장소",
    theme: { label: "테마", system: "시스템 테마", light: "밝은 테마", dark: "어두운 테마" },
    search: {
      button: "검색",
      label: "문서 검색",
      move: "이동",
      open: "열기",
      close: "닫기",
      loading: "찾는 중…",
      empty: "결과 없음",
      unavailable: "검색 색인 없음 · 빌드 후 사용 가능",
    },
    planned: { badge: "예정", reason: "준비 중인 문서", card: "준비 중" },
    page: { toc: "이 페이지", previous: "이전", next: "다음", pager: "이전 및 다음 문서", copyCode: "코드 복사" },
    footer: { status: "정식 출시 전", designSystem: "디자인 시스템", releases: "릴리스" },
    home: {
      title: "Butler 사용 설명서",
      description: "설치부터 모델, 확장, 문제 해결까지 Butler 앱을 쓰는 방법을 정리합니다.",
    },
    notFound: {
      title: "페이지를 찾을 수 없습니다",
      description: "주소가 바뀌었거나 없는 페이지입니다.",
      home: "사용 설명서 처음으로",
    },
  },
  en: {
    languageName: "English",
    languageCode: "EN",
    product: "Manual",
    skipToContent: "Skip to content",
    menu: "Menu",
    closeMenu: "Close menu",
    sidebar: "Manual navigation",
    docs: "Docs",
    breadcrumb: "Breadcrumb",
    language: "Language",
    githubRepository: "GitHub repository",
    theme: { label: "Theme", system: "System theme", light: "Light theme", dark: "Dark theme" },
    search: {
      button: "Search",
      label: "Search the manual",
      move: "Move",
      open: "Open",
      close: "Close",
      loading: "Searching…",
      empty: "No results",
      unavailable: "No search index · available after a build",
    },
    planned: { badge: "Planned", reason: "Page in progress", card: "Coming soon" },
    page: { toc: "On this page", previous: "Previous", next: "Next", pager: "Previous and next pages", copyCode: "Copy code" },
    footer: { status: "Pre-release", designSystem: "Design system", releases: "Releases" },
    home: {
      title: "Butler manual",
      description: "How to use the Butler app, from installation to models, extensions and troubleshooting.",
    },
    notFound: {
      title: "Page not found",
      description: "The address changed or the page does not exist.",
      home: "Back to the manual",
    },
  },
};

export function ui(locale: Locale): UiCopy {
  return UI[locale];
}
