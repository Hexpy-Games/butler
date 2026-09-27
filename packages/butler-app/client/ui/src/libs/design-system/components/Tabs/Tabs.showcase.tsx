import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Activity, Blocks, Command, FileText, Folder, History, LayoutDashboard, ListChecks } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";

export const meta: ShowcaseMeta = {
  title: "Tabs",
  category: "Navigation",
  tags: ["navigation", "tabs", "panels"],
  status: "stable",
};

const labels = {
  "en-US": { summary: "Summary", files: "Files", workers: "Workers", sections: "Inspector sections", summaryHint: "Right-panel tab surface.", filesHint: "Changed files and artifacts.", workersHint: "Worker activity and review state.", overview: "Overview", work: "Work", materials: "Materials", history: "History", statistics: "Statistics", panel: "Panel content" },
  "ko-KR": { summary: "요약", files: "파일", workers: "Worker", sections: "인스펙터 섹션", summaryHint: "오른쪽 패널 탭 표면입니다.", filesHint: "변경된 파일과 산출물.", workersHint: "Worker 활동과 검토 상태.", overview: "개요", work: "작업", materials: "자료", history: "기록", statistics: "통계", panel: "패널 내용" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Inspector sections (default, stretch)",
    render: (context) => {
      const copy = text(context);
      return (
        <Tabs defaultValue="summary">
          <TabsList stretch aria-label={copy.sections}>
            <TabsTrigger value="summary"><Command size="md" />{copy.summary}</TabsTrigger>
            <TabsTrigger value="files"><FileText size="md" />{copy.files}</TabsTrigger>
            <TabsTrigger value="workers"><Blocks size="md" />{copy.workers}</TabsTrigger>
          </TabsList>
          <TabsContent value="summary">
            <Stack gap="xs"><Typo.PanelSectionTitle>{copy.summary}</Typo.PanelSectionTitle><Typo.Caption>{copy.summaryHint}</Typo.Caption></Stack>
          </TabsContent>
          <TabsContent value="files"><Typo.Caption>{copy.filesHint}</Typo.Caption></TabsContent>
          <TabsContent value="workers"><Typo.Caption>{copy.workersHint}</Typo.Caption></TabsContent>
        </Tabs>
      );
    },
  },
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
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "selected", "disabled"],
  variants: ["default", "line"],
  render: (context) => (
    <Tabs defaultValue={context.state === "selected" ? "work" : "overview"}>
      <TabsList variant={context.variant === "line" ? "line" : undefined}>
        <TabsTrigger value="work" disabled={context.state === "disabled"}><ListChecks />{text(context).work}</TabsTrigger>
      </TabsList>
    </Tabs>
  ),
};
