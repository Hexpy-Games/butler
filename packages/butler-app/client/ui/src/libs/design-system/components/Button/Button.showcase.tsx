import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { ButtonContainer } from "../ButtonContainer";
import { Plus, Search, Trash2 } from "../Icons";
import { Button } from "./Button";

export const meta: ShowcaseMeta = {
  title: "Button",
  category: "Action",
  tags: ["action", "control", "borderless"],
  status: "stable",
};

const labels = {
  "en-US": { create: "Create", search: "Search", more: "More", remove: "Delete", save: "Save changes", details: "Show details" },
  "ko-KR": { create: "만들기", search: "검색", more: "더 보기", remove: "삭제", save: "변경 사항 저장", details: "자세히 보기" },
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
    name: "Disabled",
    states: ["disabled"],
    render: (context) => (
      <ButtonContainer size="default">
        <Button disabled text={text(context).save} />
        <Button disabled text={text(context).search} variant="outline" />
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
