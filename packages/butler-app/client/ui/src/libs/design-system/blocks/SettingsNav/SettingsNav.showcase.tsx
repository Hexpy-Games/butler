import { useState, type ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Activity, AiChip, Database, McpServer, Palette, Settings, ShieldCheck, Sparkles } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { SettingsNav } from "./SettingsNav";

export const meta: ShowcaseMeta = {
  title: "SettingsNav",
  category: "Settings & Forms",
  tags: ["settings", "navigation", "sidebar"],
  status: "stable",
};

const labels = {
  "en-US": {
    app: "App", general: "General", appearance: "Appearance", privacy: "Privacy", models: "Models", mcp: "MCP servers",
    skills: "Skills", usage: "Usage", data: "Data", butler: "Butler", update: "1",
  },
  "ko-KR": {
    app: "앱", general: "일반", appearance: "화면", privacy: "개인정보", models: "모델", mcp: "MCP 서버",
    skills: "스킬", usage: "사용량", data: "데이터", butler: "버틀러", update: "1",
  },
} as const;

/** SettingsSidebar: one SettingsNav per group, a single active section across groups. */
function SettingsSidebar({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  const [active, setActive] = useState("general");
  const item = (id: string, label: string, icon: ReactNode, badge?: string) =>
    ({ id, label, icon, badge, active: active === id, onSelect: () => setActive(id) });
  return (
    <Stack gap="lg">
      <SettingsNav title={copy.app} items={[
        item("general", copy.general, <Settings size="md" />, copy.update),
        item("appearance", copy.appearance, <Palette size="md" />),
        item("privacy", copy.privacy, <ShieldCheck size="md" />),
      ]} />
      <SettingsNav title={copy.butler} items={[
        item("models", copy.models, <AiChip size="md" />),
        item("mcp", copy.mcp, <McpServer size="md" />),
        item("skills", copy.skills, <Sparkles size="md" />),
        item("usage", copy.usage, <Activity size="md" />),
        item("data", copy.data, <Database size="md" />),
      ]} />
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Grouped sections", states: ["selected"], widths: ["320", "375", "app"], render: (context) => <SettingsSidebar context={context} /> },
  {
    name: "Untitled group",
    render: (context) => (
      <SettingsNav items={[
        { id: "general", label: labels[context.locale].general, icon: <Settings size="md" />, active: true },
        { id: "appearance", label: labels[context.locale].appearance, icon: <Palette size="md" /> },
      ]} />
    ),
  },
];
