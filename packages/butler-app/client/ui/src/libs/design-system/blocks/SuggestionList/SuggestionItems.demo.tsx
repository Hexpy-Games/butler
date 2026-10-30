import type { ShowcaseRenderContext } from "../../showcase";
import { Briefcase, MessageSquare, Notebook } from "../../components/Icons";
import { SuggestionItemRow, SuggestionList } from "./SuggestionList";

export interface AppItem { kind: "project" | "project-chat" | "chat"; title: string; meta?: string }

/** The composer `@` menu: conversations and projects; the muted meta names the project, or the type. */
export const ITEMS: Record<ShowcaseRenderContext["locale"], { list: string; query: string; items: AppItem[] }> = {
  "en-US": {
    list: "Reference a chat or project", query: "design",
    items: [
      { kind: "project-chat", title: "Design system cleanup", meta: "butler" },
      { kind: "project", title: "Design research", meta: "Project" },
      { kind: "project-chat", title: "Composer design review", meta: "butler" },
      { kind: "chat", title: "Landing page redesign" },
      { kind: "project-chat", title: "Interview notes", meta: "Design research" },
    ],
  },
  "ko-KR": {
    list: "대화·프로젝트 참조", query: "디자인",
    items: [
      { kind: "project-chat", title: "디자인 시스템 정리", meta: "butler" },
      { kind: "project", title: "디자인 리서치", meta: "프로젝트" },
      { kind: "project-chat", title: "컴포저 디자인 검토", meta: "butler" },
      { kind: "chat", title: "랜딩 페이지 리디자인" },
      { kind: "project-chat", title: "사용자 인터뷰 정리", meta: "디자인 리서치" },
    ],
  },
};

export const itemIcon = (kind: AppItem["kind"]) => kind === "project" ? <Briefcase size="md" /> : kind === "project-chat" ? <Notebook size="md" /> : <MessageSquare size="md" />;

export function ItemRows({ locale, active, query }: ShowcaseRenderContext & { active: number; query: string }) {
  const copy = ITEMS[locale];
  return (
    <SuggestionList id={`items-${locale}`} label={copy.list}>
      {copy.items.map((item, index) => (
        <SuggestionItemRow key={item.title} id={`item-${locale}-${index}`} icon={itemIcon(item.kind)} title={item.title} meta={item.meta}
          matchMeta={item.kind === "project-chat"}
          query={query} active={index === active} onSelect={() => undefined} />
      ))}
    </SuggestionList>
  );
}
