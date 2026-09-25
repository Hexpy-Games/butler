import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Input } from "../../components/Input";
import { Switch } from "../../components/Switch";
import { SettingsField } from "../SettingsField";
import { FormSection } from "./FormSection";
import styles from "./FormSection.showcase.module.css";

export const meta: ShowcaseMeta = {
  title: "FormSection",
  category: "Settings & Forms",
  tags: ["form", "section", "grouping", "settings"],
  status: "stable",
};

const labels = {
  "en-US": {
    general: "General",
    search: "Search",
    searchDescription: "Configure web search providers and pre-search planning. Providers that need keys can store secrets here.",
    model: "Model settings",
    name: "Display name",
    nameDescription: "Shown in Butler messages.",
    smartGroups: "Smart groups",
    smartGroupsDescription: "Automatically organize new conversations by topic.",
    provider: "Search provider",
    theme: "Home screen theme",
    context: "Context limit",
  },
  "ko-KR": {
    general: "일반",
    search: "검색",
    searchDescription: "웹 검색 제공자와 사전 검색 계획을 설정합니다. 키가 필요한 제공자는 여기에 비밀 값을 저장할 수 있습니다.",
    model: "모델 설정",
    name: "표시 이름",
    nameDescription: "Butler 메시지에 표시됩니다.",
    smartGroups: "스마트 그룹",
    smartGroupsDescription: "새 대화를 주제별로 자동 정리합니다.",
    provider: "검색 제공자",
    theme: "홈 화면 테마",
    context: "컨텍스트 한도",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function Fields({ context, id }: { context: ShowcaseRenderContext; id: string }) {
  const t = text(context);
  return (
    <>
      <SettingsField id={`${id}-name`} label={t.name} description={t.nameDescription}
        control={<Input id={`${id}-name`} defaultValue="Butler" />} />
      <SettingsField id={`${id}-groups`} label={t.smartGroups} description={t.smartGroupsDescription}
        control={<Switch id={`${id}-groups`} />} />
    </>
  );
}

/** Stacked sections the way SettingsShell lays them out (its section gap). */
function Stacked({ context }: { context: ShowcaseRenderContext }) {
  const t = text(context);
  return (
    <div className={styles.stack}>
      <FormSection title={t.general}><Fields context={context} id="stacked-general" /></FormSection>
      <FormSection title={t.search} description={t.searchDescription}>
        <SettingsField id="stacked-provider" label={t.provider} control={<Input id="stacked-provider" defaultValue="Tavily" />} />
      </FormSection>
      <FormSection title={t.model}>
        <SettingsField id="stacked-context" label={t.context} control={<Input id="stacked-context" defaultValue="258000" />} />
      </FormSection>
    </div>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Title and description above the card",
    render: (context) => (
      <FormSection title={text(context).search} description={text(context).searchDescription}>
        <Fields context={context} id="described" />
      </FormSection>
    ),
  },
  {
    name: "Title only",
    render: (context) => (
      <FormSection title={text(context).model}><Fields context={context} id="title-only" /></FormSection>
    ),
  },
  {
    name: "No header (page title names the card)",
    render: (context) => (
      <FormSection>
        <SettingsField id="bare-theme" label={text(context).theme} control={<Input id="bare-theme" defaultValue="Bloom" />} />
      </FormSection>
    ),
  },
  {
    name: "Stacked sections (header belongs to the card below)",
    widths: ["375", "app", "wide"],
    render: (context) => <Stacked context={context} />,
  },
];
