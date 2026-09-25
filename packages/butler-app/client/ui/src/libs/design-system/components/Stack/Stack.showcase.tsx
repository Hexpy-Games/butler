import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { Tag } from "../Tag";
import { Typo } from "../Typo";
import { Stack } from "./Stack";

export const meta: ShowcaseMeta = {
  title: "Stack",
  category: "Layout",
  tags: ["layout", "flex", "row", "column", "item-props"],
  status: "stable",
};

const labels = {
  "en-US": {
    first: "First", second: "Second", third: "Third",
    title: "Desktop client polish for the dashboard and the settings screens",
    meta: "Updated 2 minutes ago", action: "Open",
    grow: "grow", fixed: "shrink={false}", basis: "basis=md",
  },
  "ko-KR": {
    first: "첫째", second: "둘째", third: "셋째",
    title: "대시보드와 설정 화면을 다듬는 데스크톱 클라이언트 작업",
    meta: "2분 전 업데이트", action: "열기",
    grow: "grow", fixed: "shrink={false}", basis: "basis=md",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Column",
    render: (context) => (
      <Stack gap="sm">
        <Typo.Body>{text(context).first}</Typo.Body>
        <Typo.Body>{text(context).second}</Typo.Body>
        <Typo.Body>{text(context).third}</Typo.Body>
      </Stack>
    ),
  },
  {
    name: "Row",
    render: (context) => (
      <Stack align="row" gap="md" cross="center">
        <Typo.Body>{text(context).first}</Typo.Body>
        <Typo.Body>{text(context).second}</Typo.Body>
        <Typo.Body>{text(context).third}</Typo.Body>
      </Stack>
    ),
  },
  {
    name: "Item grow, basis and shrink",
    render: (context) => (
      <Stack gap="sm">
        <Stack align="row" gap="sm">
          <Stack.Item grow><Tag>{text(context).grow}</Tag></Stack.Item>
          <Stack.Item shrink={false}><Tag>{text(context).fixed}</Tag></Stack.Item>
        </Stack>
        <Stack align="row" gap="sm" wrap>
          <Stack.Item grow basis="md" minWidth="0"><Tag>{text(context).basis}</Tag></Stack.Item>
          <Stack.Item grow basis="md" minWidth="0"><Tag>{text(context).basis}</Tag></Stack.Item>
        </Stack>
      </Stack>
    ),
  },
  {
    name: "Truncation in a row",
    widths: ["320", "375", "430"],
    render: (context) => (
      <Stack align="row" gap="sm" cross="center">
        <Stack gap="none" grow minWidth="0">
          <Typo.Body truncate>{text(context).title}</Typo.Body>
          <Typo.Caption tone="secondary" truncate>{text(context).meta}</Typo.Caption>
        </Stack>
        <Stack.Item shrink={false}>
          <Button size="sm" variant="outline" text={text(context).action} />
        </Stack.Item>
      </Stack>
    ),
  },
];
