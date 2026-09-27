import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory, ShowcaseStateMatrix } from "../../showcase";
import { IconButton } from "../IconButton";
import { ArrowLeft } from "../Icons";
import { Stack } from "../Stack";
import {
  Breadcrumb,
  BreadcrumbButton,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./Breadcrumb";

export const meta: ShowcaseMeta = {
  title: "Breadcrumb",
  category: "Navigation",
  tags: ["navigation", "hierarchy", "settings", "automation"],
  status: "stable",
};

const labels = {
  "en-US": { back: "Back", models: "Models", management: "Model management", add: "Add model", automations: "Schedules", nightly: "Nightly release notes", docs: "Docs", trail: "Location", more: "More" },
  "ko-KR": { back: "뒤로", models: "모델", management: "모델 관리", add: "모델 추가", automations: "예약 작업", nightly: "야간 릴리스 노트", docs: "문서", trail: "현재 위치", more: "더보기" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** Model settings title: back IconButton + in-app BreadcrumbButton steps (ModelSettingsTitle). */
function ModelSettingsTrail(context: ShowcaseRenderContext) {
  const copy = text(context);
  return (
    <Stack align="row" cross="center" gap="xs">
      <IconButton label={copy.back} onClick={() => undefined}>
        <ArrowLeft size="md" />
      </IconButton>
      <Breadcrumb label={text(context).trail}>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbButton onClick={() => undefined}>{copy.models}</BreadcrumbButton>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbButton onClick={() => undefined}>{copy.management}</BreadcrumbButton>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{copy.add}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Model settings trail", render: (context) => <ModelSettingsTrail {...context} /> },
  {
    name: "Automation detail",
    render: (context) => (
      <Breadcrumb label={text(context).trail}>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbButton onClick={() => undefined}>{text(context).automations}</BreadcrumbButton>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{text(context).nightly}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    ),
  },
  {
    name: "Collapsed path with link",
    widths: ["320", "375", "app"],
    render: (context) => (
      <Breadcrumb label={text(context).trail}>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="#docs">{text(context).docs}</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbEllipsis label={text(context).more} />
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{text(context).add}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active"],
  render: (context) => <BreadcrumbButton onClick={() => undefined}>{text(context).models}</BreadcrumbButton>,
};
