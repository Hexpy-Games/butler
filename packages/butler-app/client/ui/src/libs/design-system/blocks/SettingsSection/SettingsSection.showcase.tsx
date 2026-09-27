import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Input } from "../../components/Input";
import { Switch } from "../../components/Switch";
import { KeyValueRow } from "../KeyValueRow";
import { SettingsField } from "../SettingsField";
import { SettingsPage } from "./SettingsPage";
import { SettingsSection } from "./SettingsSection";

export const meta: ShowcaseMeta = {
  title: "SettingsSection",
  category: "Settings & Forms",
  tags: ["settings", "section", "page", "loading", "error", "empty", "toolbar"],
  status: "stable",
};

const copy = {
  "en-US": {
    labels: { loading: "Loading", error: "Could not load this section.", retry: "Retry", empty: "Nothing to show yet." },
    region: "Language & region", language: "Language", timezone: "Time zone",
    notifications: "Notifications", replies: "New replies", check: "Check for updates",
    updates: "App", upToDate: "Up to date", info: "App info", version: "Version", name: "Name",
    apply: "Apply", reset: "Reset profile", servers: "No MCP servers yet.",
  },
  "ko-KR": {
    labels: { loading: "불러오는 중", error: "이 섹션을 불러오지 못했습니다.", retry: "다시 시도", empty: "아직 표시할 항목이 없습니다." },
    region: "언어 및 지역", language: "언어", timezone: "시간대",
    notifications: "알림", replies: "새 답변", check: "업데이트 확인",
    updates: "앱", upToDate: "최신 버전", info: "앱 정보", version: "버전", name: "이름",
    apply: "적용", reset: "프로필 초기화", servers: "아직 MCP 서버가 없습니다.",
  },
} as const;

function Form({ locale }: ShowcaseRenderContext) {
  const t = copy[locale];
  return (
    <SettingsPage labels={t.labels}>
      <SettingsSection id="language-region" kind="form" title={t.region}>
        <SettingsField id="sc-language" settingId="language" label={t.language} control={<Input id="sc-language" defaultValue="English" />} />
        <SettingsField id="sc-timezone" settingId="timezone" label={t.timezone} control={<Input id="sc-timezone" defaultValue="Asia/Seoul" />} />
      </SettingsSection>
      <SettingsSection id="notifications" kind="form" title={t.notifications}>
        <SettingsField id="sc-replies" settingId="replies" label={t.replies} control={<Switch id="sc-replies" defaultChecked />} />
      </SettingsSection>
    </SettingsPage>
  );
}

function States({ locale }: ShowcaseRenderContext) {
  const t = copy[locale];
  return (
    <SettingsPage labels={t.labels}>
      <SettingsSection id="updates" kind="list" actions={<Button size="sm" variant="outline">{t.check}</Button>}>
        <KeyValueRow label={t.updates} value={t.upToDate} />
      </SettingsSection>
      <SettingsSection id="loading" kind="list" state="loading" />
      <SettingsSection id="error" kind="status" state="error" onRetry={() => undefined} />
      <SettingsSection id="empty" kind="list" state="empty" emptyMessage={t.servers} />
    </SettingsPage>
  );
}

function Info({ locale }: ShowcaseRenderContext) {
  const t = copy[locale];
  return (
    <SettingsPage labels={t.labels} footer={(
      <ButtonContainer size="default" justify="end">
        <Button variant="outline">{t.reset}</Button>
        <Button>{t.apply}</Button>
      </ButtonContainer>
    )}>
      <SettingsSection id="app-info" kind="info" title={t.info}>
        <KeyValueRow label={t.name} value="Butler" />
        <KeyValueRow label={t.version} value="0.0.21" />
      </SettingsSection>
    </SettingsPage>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Form sections", widths: ["375", "app"], render: (context) => <Form {...context} /> },
  { name: "Toolbar, loading, error and empty", widths: ["375", "app"], render: (context) => <States {...context} /> },
  { name: "Info rows with a sticky footer", render: (context) => <Info {...context} /> },
];
