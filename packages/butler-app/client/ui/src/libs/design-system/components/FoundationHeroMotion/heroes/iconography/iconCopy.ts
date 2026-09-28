import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/** Sample copy of the Iconography hero. Token names and numbers never translate. */
export const ICON_COPY = {
  en: {
    title: "Iconography",
    lead: [
      ["Glyphs", "Hugeicons stroke glyphs on a 24px grid, one weight throughout."],
      ["Sizes", "Six named sizes, 12 to 32; pass the name, never pixels."],
      ["Pairing", "An icon takes the size of the type it sits beside, centred on its line."],
    ] as IntroLead,
    pairs: ["Status", "Filter", "Settings", "Butler", "Projects", "Welcome"],
    grid: "24 × 24 grid", padding: "2px padding", stroke: "1.5 stroke",
    chats: "Chats", projects: "Projects", files: "Files", search: "Search",
    settings: "Settings", newChat: "New chat", beta: "Beta", synced: "Synced",
    emptyTitle: "No projects yet", emptyHint: "Start one from any conversation.", create: "New project",
    rename: "Rename", duplicate: "Duplicate", archive: "Archive",
  },
  ko: {
    title: "Iconography",
    lead: [
      ["글리프", "24px 격자 위의 Hugeicons 선 글리프, 굵기는 하나로."],
      ["크기", "12부터 32까지 이름 붙은 여섯 크기. 픽셀 대신 이름을 씁니다."],
      ["짝짓기", "아이콘은 옆 글자의 역할 크기를 따르고, 같은 중심선에 놓입니다."],
    ] as IntroLead,
    pairs: ["상태", "필터", "설정", "Butler", "프로젝트", "환영합니다"],
    grid: "24 × 24 격자", padding: "2px 여백", stroke: "1.5 선",
    chats: "대화", projects: "프로젝트", files: "파일", search: "검색",
    settings: "설정", newChat: "새 대화", beta: "베타", synced: "동기화됨",
    emptyTitle: "아직 프로젝트가 없어요", emptyHint: "어느 대화에서든 시작할 수 있어요.", create: "새 프로젝트",
    rename: "이름 바꾸기", duplicate: "복제", archive: "보관",
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type IconCopy = (typeof ICON_COPY)["en"];

/** The five steps of the label row: a type role and the icon size that pairs with it. */
export const STEPS = [
  { role: "caption", icon: "xs", px: 12 }, { role: "body", icon: "md", px: 16 }, { role: "h4", icon: "lg", px: 20 },
  { role: "h3", icon: "xl", px: 24 }, { role: "h2", icon: "2xl", px: 32 },
] as const;

