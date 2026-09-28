/** Docs information architecture: section order and labels per locale. */
export const LOCALES = ["ko", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ko";

export const SECTIONS = [
  { id: "getting-started", title: { ko: "시작하기", en: "Getting started" } },
  { id: "basics", title: { ko: "기본 사용", en: "Basics" } },
  { id: "projects", title: { ko: "프로젝트", en: "Projects" } },
  { id: "scheduled-tasks", title: { ko: "예약 작업", en: "Scheduled tasks" } },
  { id: "models", title: { ko: "모델", en: "Models" } },
  { id: "extensions", title: { ko: "확장", en: "Extensions" } },
  { id: "personalization", title: { ko: "개인화", en: "Personalization" } },
  { id: "settings", title: { ko: "설정 레퍼런스", en: "Settings reference" } },
  { id: "advanced", title: { ko: "고급", en: "Advanced" } },
  { id: "troubleshooting", title: { ko: "문제 해결", en: "Troubleshooting" } },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];
export const SECTION_IDS = SECTIONS.map((section) => section.id) as [SectionId, ...SectionId[]];
