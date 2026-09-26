import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Input } from "../../components/Input";
import { Switch } from "../../components/Switch";
import { FormSection } from "../FormSection";
import { SettingsField } from "../SettingsField";
import { SettingsHeader } from "../SettingsHeader";
import { SettingsNav } from "../SettingsNav";
import { SettingsShell } from "./SettingsShell";
import styles from "./SettingsShell.showcase.module.css";

export const meta: ShowcaseMeta = {
  title: "SettingsShell",
  category: "Settings & Forms",
  tags: ["settings", "shell", "page", "layout"],
  status: "stable",
};

const copy = {
  "en-US": {
    general: "General", mcp: "MCP", mcpDescription: "Manage MCP servers and their connection settings.",
    generalDescription: "Configure language, timezone, conversation input, and search defaults.",
    notifications: "Notifications", language: "Language", smartGroups: "Smart groups", replies: "New replies",
    server: "Server URL",
  },
  "ko-KR": {
    general: "일반", mcp: "MCP", mcpDescription: "MCP 서버와 연결 정보를 관리합니다.",
    generalDescription: "언어, 시간대, 대화 입력과 검색 기본값을 설정합니다.",
    notifications: "알림", language: "언어", smartGroups: "스마트 그룹", replies: "새 답변",
    server: "서버 URL",
  },
} as const;

function Page({ locale, page }: ShowcaseRenderContext & { page: "general" | "mcp" }) {
  const text = copy[locale];
  const title = page === "general" ? text.general : text.mcp;
  const description = page === "general" ? text.generalDescription : text.mcpDescription;
  return (
    <div className={styles.showcaseFrame}>
      <SettingsShell
        pageTitle={title}
        pageDescription={description}
        sidebar={<SettingsNav items={[
          { id: "general", label: text.general, active: page === "general" },
          { id: "mcp", label: text.mcp, active: page === "mcp" },
        ]} />}
        detailHeader={<SettingsHeader title={title} description={description} />}
        detail={page === "general" ? (
          <>
            {/* The first card's title repeats the page title: FormSection drops it. */}
            <FormSection title={text.general}>
              <SettingsField id={`${locale}-language`} label={text.language} control={<Input id={`${locale}-language`} defaultValue="English" />} />
              <SettingsField id={`${locale}-groups`} label={text.smartGroups} control={<Switch id={`${locale}-groups`} defaultChecked />} />
            </FormSection>
            <FormSection title={text.notifications}>
              <SettingsField id={`${locale}-replies`} label={text.replies} control={<Switch id={`${locale}-replies`} />} />
            </FormSection>
          </>
        ) : (
          <FormSection title={text.mcp} description={description}>
            <SettingsField id={`${locale}-server`} label={text.server} control={<Input id={`${locale}-server`} defaultValue="http://127.0.0.1:8931" />} />
          </FormSection>
        )}
      />
    </div>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Start-aligned page (narrow PageContainer)", widths: ["app", "wide"], render: (context) => <Page {...context} page="general" /> },
  { name: "Single card whose header repeats the page", render: (context) => <Page {...context} page="mcp" /> },
];
