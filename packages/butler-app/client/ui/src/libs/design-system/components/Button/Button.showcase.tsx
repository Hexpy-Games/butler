import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { ButtonContainer } from "../ButtonContainer";
import { Plus, Search, Trash2 } from "../Icons";
import { Stack } from "../Stack";
import { Button } from "./Button";

export const meta: ShowcaseMeta = {
  title: "Button",
  category: "Action",
  tags: ["action", "control", "borderless"],
  status: "stable",
};

const labels = {
  "en-US": { create: "Create", search: "Search", more: "More", remove: "Delete", save: "Save changes", details: "Show details", long: "Draft the report · 2/4 · Reading the source documents and noting key points" },
  "ko-KR": { create: "만들기", search: "검색", more: "더 보기", remove: "삭제", save: "변경 사항 저장", details: "자세히 보기", long: "보고서 초안 작성 · 2/4 · 출처 문서를 읽고 핵심 내용을 정리하는 중" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Variants",
    render: (context) => (
      <ButtonContainer size="default">
        <Button iconStart={<Plus size="md" />} text={text(context).create} />
        <Button iconStart={<Search size="md" />} text={text(context).search} variant="outline" />
        <Button iconEnd={<Plus size="md" />} text={text(context).more} variant="borderless" />
        <Button text={text(context).details} variant="ghost" />
        <Button iconStart={<Trash2 size="md" />} text={text(context).remove} variant="destructive" />
      </ButtonContainer>
    ),
  },
  {
    name: "Sizes",
    render: (context) => (
      <ButtonContainer size="default">
        <Button size="xs" text={text(context).save} />
        <Button size="sm" text={text(context).save} />
        <Button text={text(context).save} />
        <Button size="lg" text={text(context).save} />
      </ButtonContainer>
    ),
  },
  {
    name: "Inline",
    render: (context) => <Button variant="inline" text={text(context).details} />,
  },
  {
    name: "Long label",
    render: (context) => (
      <Stack align="row" gap="sm">
        <Stack.Item maxWidth="1/2" minWidth="0">
          <Button variant="outline" shape="pill" text={text(context).long} title={text(context).long} />
        </Stack.Item>
      </Stack>
    ),
  },
  {
    name: "Disabled",
    states: ["disabled"],
    render: (context) => (
      <ButtonContainer size="default">
        <Button disabled text={text(context).save} />
        <Button disabled text={text(context).search} variant="outline" />
        <Button aria-disabled text={text(context).save} variant="outline" />
      </ButtonContainer>
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active", "disabled"],
  variants: ["default", "outline", "borderless", "ghost", "destructive"],
  render: (context) => (
    <Button disabled={context.state === "disabled"} text={text(context).save}
      variant={context.variant as "default" | "outline" | "borderless" | "ghost" | "destructive"} />
  ),
};
