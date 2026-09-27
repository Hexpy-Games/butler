import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Typo } from "../../components/Typo";
import { Notice } from "../Notice";
import { SettingsHeader } from "./SettingsHeader";

export const meta: ShowcaseMeta = {
  title: "SettingsHeader",
  category: "Settings & Forms",
  tags: ["settings", "header", "title", "status"],
  status: "stable",
};

const labels = {
  "en-US": {
    appearance: "Appearance", appearanceHint: "Choose a theme and density that fits your workspace.", reset: "Reset",
    models: "Models", modelsHint: "Connect providers and choose the default model.", secondary: "3 providers connected", saved: "Settings saved",
  },
  "ko-KR": {
    appearance: "화면", appearanceHint: "작업 공간에 맞는 테마와 밀도를 고르세요.", reset: "초기화",
    models: "모델", modelsHint: "제공자를 연결하고 기본 모델을 고르세요.", secondary: "제공자 3개 연결됨", saved: "설정을 저장했습니다",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Title, description and action",
    widths: ["375", "app"],
    render: (context) => (
      <SettingsHeader title={text(context).appearance} description={text(context).appearanceHint}
        action={<Button size="sm" variant="outline" text={text(context).reset} />} />
    ),
  },
  {
    // SettingsDetailHeader: a secondary line and the save result as the action slot.
    name: "Secondary line and save status",
    render: (context) => (
      <SettingsHeader title={text(context).models} description={text(context).modelsHint}
        secondary={<Typo.Caption tone="secondary">{text(context).secondary}</Typo.Caption>}
        action={<Notice message={text(context).saved} tone="success" />} />
    ),
  },
];
