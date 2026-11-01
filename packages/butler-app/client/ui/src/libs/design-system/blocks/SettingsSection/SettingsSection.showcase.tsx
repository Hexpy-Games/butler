import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { PencilLine, Plus, RefreshCcw, Trash2 } from "../../components/Icons";
import { Input } from "../../components/Input";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Switch } from "../../components/Switch";
import { CardList, CardListItem } from "../CardList";
import { KeyValueRow } from "../KeyValueRow";
import { ProgressMeter } from "../ProgressMeter";
import { SettingsActionField } from "../SettingsActionField";
import { SettingsField } from "../SettingsField";
import { SettingsPage } from "./SettingsPage";
import { SettingsSection } from "./SettingsSection";

export const meta: ShowcaseMeta = {
  title: "SettingsSection",
  category: "Settings & Forms",
  tags: ["settings", "section", "page", "loading", "error", "empty", "actions", "more", "list"],
  status: "stable",
};

const copy = {
  "en-US": {
    labels: { loading: "Loading", error: "Could not load this section.", retry: "Retry", empty: "Nothing to show yet." },
    region: "Language & region", language: "Language", timezone: "Time zone", notifications: "Notifications", replies: "New replies",
    check: "Check for updates", versions: "Versions", app: "Butler", upToDate: "Up to date", servers: "Servers", usage: "Usage",
    archived: "Archived items", noServers: "No MCP servers yet.", add: "Add server", more: "More", refresh: "Refresh",
    profile: "Profile", nickname: "Nickname", save: "Save", cancel: "Cancel", storage: "Storage", agentLogs: "Agent", agentMeta: "12 MB of 100 MB · 14 days",
    clear: "Delete all logs", clearDescription: "Removes saved logs and bodies. This can't be undone.", clearAction: "Delete all…",
    period: "Period", day: "Day", week: "Week", month: "Month", tokens: "Tokens", cost: "Cost", test: "Test", edit: "Edit", remove: "Remove", enabled: "On",
    rows: [["filesystem", "stdio · 12 tools"], ["github", "http · 31 tools"], ["linear", "http · Needs a key"]],
  },
  "ko-KR": {
    labels: { loading: "불러오는 중", error: "이 섹션을 불러오지 못했습니다.", retry: "다시 시도", empty: "아직 표시할 항목이 없습니다." },
    region: "언어 및 지역", language: "언어", timezone: "시간대", notifications: "알림", replies: "새 답변",
    check: "업데이트 확인", versions: "버전", app: "버틀러", upToDate: "최신 버전", servers: "서버", usage: "사용량",
    archived: "보관된 항목", noServers: "아직 MCP 서버가 없습니다.", add: "서버 추가", more: "더보기", refresh: "새로고침",
    profile: "프로필", nickname: "호칭", save: "저장", cancel: "취소", storage: "저장 공간", agentLogs: "에이전트", agentMeta: "100 MB 중 12 MB · 14일",
    clear: "로그 모두 삭제", clearDescription: "저장된 로그와 본문을 지웁니다. 되돌릴 수 없습니다.", clearAction: "모두 삭제…",
    period: "기간", day: "일", week: "주", month: "월", tokens: "토큰", cost: "비용", test: "테스트", edit: "편집", remove: "삭제", enabled: "사용",
    rows: [["filesystem", "stdio · 도구 12개"], ["github", "http · 도구 31개"], ["linear", "http · 키 필요"]],
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

const AddButton = ({ label }: { label: string }) => <Button size="sm" variant="outline"><Plus size="md" />{label}</Button>;

function States({ locale }: ShowcaseRenderContext) {
  const t = copy[locale];
  return (
    <SettingsPage labels={t.labels}>
      <SettingsSection id="updates" kind="list" title={t.versions} actions={<Button size="sm" variant="outline"><RefreshCcw size="md" />{t.check}</Button>}>
        <KeyValueRow label={t.app} value={t.upToDate} />
      </SettingsSection>
      <SettingsSection id="loading" kind="list" title={t.servers} state="loading" />
      <SettingsSection id="error" kind="status" title={t.usage} state="error" onRetry={() => undefined} />
      <SettingsSection id="empty" kind="list" title={t.servers} state="empty" emptyMessage={t.noServers} actions={<AddButton label={t.add} />} />
    </SettingsPage>
  );
}

function ServerRow({ locale, name, meta }: { locale: ShowcaseRenderContext["locale"]; name: string; meta: string }) {
  const t = copy[locale];
  return (
    <CardListItem title={name} description={meta} meta={t.enabled} actions={(
      <ButtonContainer size="xs">
        <Button size="xs" variant="outline" aria-label={t.test}><RefreshCcw size="sm" /></Button>
        <Switch aria-label={`${name}: ${t.enabled}`} defaultChecked />
        <Button size="xs" variant="outline" aria-label={t.edit}><PencilLine size="sm" /></Button>
        <Button size="xs" variant="outline" aria-label={t.remove}><Trash2 size="sm" /></Button>
      </ButtonContainer>
    )} />
  );
}

function FlushList({ locale }: ShowcaseRenderContext) {
  const t = copy[locale];
  return (
    <SettingsPage labels={t.labels}>
      <SettingsSection id="servers" kind="list" title={t.servers} actions={<AddButton label={t.add} />}>
        <CardList>{t.rows.map(([name, meta]) => <ServerRow key={name} locale={locale} name={name} meta={meta} />)}</CardList>
      </SettingsSection>
      <SettingsSection id="archived" kind="list" title={t.archived} more={{ label: t.more, onClick: () => undefined }}>
        {t.rows.map(([name, meta]) => <CardListItem key={name} title={name} description={meta} />)}
      </SettingsSection>
    </SettingsPage>
  );
}

function StatusActions({ locale }: ShowcaseRenderContext) {
  const t = copy[locale];
  return (
    <SettingsPage labels={t.labels}>
      <SettingsSection id="usage" kind="status" title={t.usage} actions={(
        <>
          <SegmentedControl ariaLabel={t.period} size="sm" value="24" onValueChange={() => undefined}
            options={[{ value: "24", label: t.day }, { value: "168", label: t.week }, { value: "720", label: t.month }]} />
          <Button size="sm" variant="outline"><RefreshCcw size="sm" />{t.refresh}</Button>
        </>
      )}>
        <KeyValueRow label={t.tokens} value="1.2M" />
        <KeyValueRow label={t.cost} value="$4.20" />
      </SettingsSection>
    </SettingsPage>
  );
}

function StatusWithAction({ locale }: ShowcaseRenderContext) {
  const t = copy[locale];
  return (
    <SettingsPage labels={t.labels}>
      <SettingsSection id="storage" kind="status" title={t.storage}>
        <ProgressMeter label={t.agentLogs} value={12} meta={t.agentMeta} />
        <SettingsActionField id="sc-clear" label={t.clear} description={t.clearDescription}
          action={<Button id="sc-clear" size="sm" variant="outline">{t.clearAction}</Button>} />
      </SettingsSection>
    </SettingsPage>
  );
}

function ExplicitSave({ locale }: ShowcaseRenderContext) {
  const t = copy[locale];
  return (
    <SettingsPage labels={t.labels} footer={(
      <ButtonContainer size="default" justify="end">
        <Button variant="outline">{t.cancel}</Button>
        <Button>{t.save}</Button>
      </ButtonContainer>
    )}>
      <SettingsSection id="profile" kind="form" title={t.profile}>
        <SettingsField id="sc-nickname" settingId="nickname" label={t.nickname} control={<Input id="sc-nickname" defaultValue={locale === "ko-KR" ? "연우" : "Yeonwoo"} />} />
      </SettingsSection>
    </SettingsPage>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Form sections", widths: ["375", "app"], render: (context) => <Form {...context} /> },
  { name: "Header actions, loading, error and empty", widths: ["375", "app"], render: (context) => <States {...context} /> },
  { name: "List rows flush in the card, more row", widths: ["375", "app"], render: (context) => <FlushList {...context} /> },
  { name: "Status header actions: period and refresh", widths: ["375", "app"], render: (context) => <StatusActions {...context} /> },
  { name: "Status card with an action row (field gap)", widths: ["375", "app"], render: (context) => <StatusWithAction {...context} /> },
  { name: "Explicit-save page: the only sticky footer", render: (context) => <ExplicitSave {...context} /> },
];
