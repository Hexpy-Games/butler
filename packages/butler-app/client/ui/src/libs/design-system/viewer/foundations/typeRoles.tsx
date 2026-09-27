import type { ComponentType, CSSProperties, ReactNode, Ref } from "react";
import { Typo, type TypoProps } from "../../components/Typo";
import { dsClass, dsStyle } from "../../lib/internal";
import type { TypeRole } from "./typeScale";
import f from "./Foundations.module.css";

export type SampleLocale = "en" | "ko";

/** The Typo variant that renders a role; roles without one are drawn from their tokens. */
export const ROLE_COMPONENTS: Record<string, [ComponentType<TypoProps>, string]> = {
  h1: [Typo.H1, "Typo.H1"], h2: [Typo.H2, "Typo.H2"], h3: [Typo.H3, "Typo.H3"], h4: [Typo.H4, "Typo.H4"],
  h5: [Typo.H5, "Typo.H5"], h6: [Typo.H6, "Typo.H6"], body: [Typo.Body, "Typo.Body"], caption: [Typo.Caption, "Typo.Caption"],
  label: [Typo.Label, "Typo.Label"], code: [Typo.Code, "Typo.Code"], "app-title": [Typo.AppTitle, "Typo.AppTitle"],
  "panel-title": [Typo.PanelTitle, "Typo.PanelTitle"], "dashboard-title": [Typo.DashboardTitle, "Typo.DashboardTitle"],
  "section-title": [Typo.SectionTitle, "Typo.SectionTitle"], "panel-section-title": [Typo.PanelSectionTitle, "Typo.PanelSectionTitle"],
  "metric-value": [Typo.MetricValue, "Typo.MetricValue"],
};

/** Where each role appears in Butler, and a line worth setting in it. */
export const ROLE_COPY: Record<string, { use: string; en: string; ko: string }> = {
  "new-chat-title": { use: "New-chat greeting, hero lines", en: "What should we build today?", ko: "오늘은 무엇을 만들어 볼까요?" },
  h1: { use: "Document and page titles", en: "Project overview", ko: "프로젝트 개요" },
  h2: { use: "Settings page titles, document sections", en: "Weekly summary", ko: "주간 요약" },
  "dashboard-title": { use: "Dashboard header", en: "Butler dashboard", ko: "Butler 대시보드" },
  h3: { use: "Document subsections", en: "Open questions", ko: "남은 질문" },
  h4: { use: "Settings section titles", en: "Appearance", ko: "화면 설정" },
  "metric-value": { use: "Metric cards (tabular)", en: "12,480", ko: "12,480건" },
  h5: { use: "Minor headings, lead copy", en: "Release checklist", ko: "릴리스 체크리스트" },
  "app-title": { use: "Window and sidebar brand", en: "New conversation", ko: "새 대화" },
  "panel-title": { use: "Panel and card titles", en: "Worker activity", ko: "작업자 활동" },
  "panel-section-title": { use: "Groups inside a panel", en: "Recent files", ko: "최근 파일" },
  h6: { use: "Smallest heading", en: "Attachments", ko: "첨부 파일" },
  body: { use: "Messages, descriptions, paragraphs", en: "Butler reads the repository, plans the change and asks before it writes.", ko: "Butler는 저장소를 읽고 변경을 계획한 뒤, 쓰기 전에 먼저 묻습니다." },
  label: { use: "Field labels, row labels", en: "Translucent sidebar", ko: "반투명 사이드바" },
  "section-title": { use: "Sidebar and menu group titles", en: "Pinned", ko: "고정됨" },
  code: { use: "Commands, paths, token names", en: "bun run lint:ds", ko: "const 인사 = \"안녕하세요\";" },
  caption: { use: "Metadata, hints, timestamps", en: "Edited 3 minutes ago · 2 files", ko: "3분 전 수정 · 파일 2개" },
};

const FALLBACK = { use: "Type role", en: "The quick brown fox jumps over the lazy dog.", ko: "다람쥐 헌 쳇바퀴에 타고파." };

export function roleCopy(role: string) {
  return ROLE_COPY[role] ?? FALLBACK;
}

export function roleComponentName(role: string): string {
  return ROLE_COMPONENTS[role]?.[1] ?? `var(--typo-${role}-*)`;
}

/** Text set in a role: through its Typo variant, or straight from its tokens. */
export function RoleText({ role, children, lang, ref }: {
  role: TypeRole;
  children: ReactNode;
  lang?: SampleLocale;
  ref?: Ref<HTMLElement>;
}) {
  const component = ROLE_COMPONENTS[role.role];
  const className = dsClass(f.roleText);
  if (component) {
    const [Variant] = component;
    return <Variant as="div" className={className} lang={lang} ref={ref} wrap="normal">{children}</Variant>;
  }
  const style = {
    "--role-size": `var(${role.size.name})`,
    "--role-weight": role.weight ? `var(${role.weight.name})` : undefined,
    "--role-line-height": role.lineHeight ? `var(${role.lineHeight.name})` : undefined,
    "--role-letter-spacing": role.letterSpacing ? `var(${role.letterSpacing.name})` : undefined,
  } as CSSProperties;
  return (
    <div className={dsClass(className, f.tokenRole)} lang={lang} ref={ref as Ref<HTMLDivElement>} style={dsStyle(style)}>
      {children}
    </div>
  );
}
