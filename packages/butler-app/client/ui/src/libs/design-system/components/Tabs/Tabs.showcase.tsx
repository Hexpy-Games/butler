import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Activity, Folder, History, LayoutDashboard, ListChecks } from "../Icons";
import { Typo } from "../Typo";
import { TabsFixture } from "./Tabs.fixtures";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";

export const meta: ShowcaseMeta = {
  title: "Tabs",
  category: "Navigation",
  tags: ["navigation", "tabs", "panels"],
  status: "stable",
};

const labels = {
  "en-US": { overview: "Overview", work: "Work", materials: "Materials", history: "History", statistics: "Statistics", panel: "Panel content" },
  "ko-KR": { overview: "개요", work: "작업", materials: "자료", history: "기록", statistics: "통계", panel: "패널 내용" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Page navigation (line)",
    states: ["active", "hover", "focus"],
    widths: ["375", "app", "wide"],
    render: (context) => {
      const copy = text(context);
      const tabs = [
        ["overview", <LayoutDashboard key="i" />, copy.overview],
        ["work", <ListChecks key="i" />, copy.work],
        ["materials", <Folder key="i" />, copy.materials],
        ["history", <History key="i" />, copy.history],
        ["statistics", <Activity key="i" />, copy.statistics],
      ] as const;
      return (
        <Tabs defaultValue="overview">
          <TabsList variant="line">
            {tabs.map(([value, icon, label]) => <TabsTrigger key={value} value={value}>{icon}{label}</TabsTrigger>)}
          </TabsList>
          {tabs.map(([value, , label]) => (
            <TabsContent key={value} value={value}><Typo.Caption tone="secondary">{`${label} · ${copy.panel}`}</Typo.Caption></TabsContent>
          ))}
        </Tabs>
      );
    },
  },
  {
    name: "Inspector sections (default, stretch)",
    render: () => <TabsFixture />,
  },
];
