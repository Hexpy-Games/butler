import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Breadcrumb, BreadcrumbButton, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "../../components/Breadcrumb";
import { SettingsHeader } from "./SettingsHeader";

export const meta: ShowcaseMeta = {
  title: "SettingsHeader",
  category: "Settings & Forms",
  tags: ["settings", "header", "title", "breadcrumb"],
  status: "stable",
};

const labels = {
  "en-US": {
    appearance: "Appearance", appearanceHint: "Choose a theme and density that fits your workspace.",
    models: "Models", modelsHint: "Connect providers and choose the default model.", management: "Manage models", add: "Add model", breadcrumb: "Breadcrumb",
  },
  "ko-KR": {
    appearance: "화면", appearanceHint: "작업 공간에 맞는 테마와 밀도를 고르세요.",
    models: "모델", modelsHint: "제공자를 연결하고 기본 모델을 고르세요.", management: "모델 관리", add: "모델 추가", breadcrumb: "이동 경로",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Title and description (every settings page)",
    widths: ["375", "app"],
    render: (context) => (
      <SettingsHeader title={text(context).appearance} description={text(context).appearanceHint} />
    ),
  },
  {
    name: "Subpage breadcrumb as the secondary line",
    widths: ["375", "app"],
    render: (context) => (
      <SettingsHeader title={text(context).models} description={text(context).modelsHint}
        secondary={(
          <Breadcrumb label={text(context).breadcrumb}>
            <BreadcrumbList>
              <BreadcrumbItem><BreadcrumbButton>{text(context).models}</BreadcrumbButton></BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem><BreadcrumbButton>{text(context).management}</BreadcrumbButton></BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem><BreadcrumbPage>{text(context).add}</BreadcrumbPage></BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        )} />
    ),
  },
];
