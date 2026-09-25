import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Clock3, PencilLine, Search, Settings } from "../../components/Icons";
import { NavRow } from "../NavRow";
import { SidebarNav, SidebarShell, SidebarTrafficSpace } from "./SidebarShell";
import styles from "./SidebarShell.showcase.module.css";

export const meta: ShowcaseMeta = {
  title: "SidebarShell",
  category: "Shell",
  tags: ["sidebar", "shell", "navigation", "sticky"],
  status: "stable",
};

const copy = {
  "en-US": {
    newChat: "New chat", search: "Search", automations: "Automations", settings: "Settings", filter: "All · Recent · Running", aria: "Sidebar",
    sessions: ["Desktop client polish", "Settings hierarchy", "Release notes draft", "General chat", "Weekly review", "Travel plan", "Reading list", "Budget check", "Interview prep", "Bug triage"],
  },
  "ko-KR": {
    newChat: "새 대화", search: "검색", automations: "자동화", settings: "설정", filter: "전체 · 최근 · 실행 중", aria: "사이드바",
    sessions: ["데스크톱 앱 다듬기", "설정 화면 위계", "릴리스 노트 초안", "일반 대화", "주간 회고", "여행 계획", "읽을거리", "예산 점검", "면접 준비", "버그 분류"],
  },
} as const;

function Sidebar({ locale, rows }: ShowcaseRenderContext & { rows: number }) {
  const text = copy[locale];
  return (
    <div className={styles.showcaseFrame}>
      <SidebarShell
        titlebar={<SidebarTrafficSpace />}
        footer={<NavRow icon={<Settings />} label={text.settings} />}
        scrollHeader={
          <SidebarNav>
            <NavRow icon={<PencilLine />} label={text.newChat} active />
            <NavRow icon={<Search />} label={text.search} />
            <NavRow icon={<Clock3 />} label={text.automations} />
          </SidebarNav>
        }
        ariaLabel={text.aria}
        stickyHeader={<NavRow label={text.filter} />}
      >
        {text.sessions.slice(0, rows).map((label, index) => (
          <NavRow key={label} label={label} badge={`${index + 1}d`} />
        ))}
      </SidebarShell>
    </div>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Default", render: (context) => <Sidebar {...context} rows={4} /> },
  { name: "Scrolling list with sticky filter", states: ["scroll", "sticky"], render: (context) => <Sidebar {...context} rows={10} /> },
];
