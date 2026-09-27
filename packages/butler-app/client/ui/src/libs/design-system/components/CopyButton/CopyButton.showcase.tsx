import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Inline } from "../Inline";
import { CopyButton } from "./CopyButton";

export const meta: ShowcaseMeta = {
  title: "CopyButton",
  category: "Action",
  tags: ["action", "copy", "clipboard", "motion", "feedback"],
  status: "beta",
};

const labels = {
  "en-US": { copy: "Copy message", copied: "Copied", code: "Copy code" },
  "ko-KR": { copy: "메시지 복사", copied: "복사됨", code: "코드 복사" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Copy and confirm",
    states: ["copied"],
    render: (context) => (
      <Inline gap="sm">
        <CopyButton text="Butler copied this message." label={text(context).copy} copiedLabel={text(context).copied} />
        <CopyButton text="const ok = true;" label={text(context).code} copiedLabel={text(context).copied} />
      </Inline>
    ),
  },
  {
    name: "Copied state",
    states: ["copied"],
    render: (context) => (
      <CopyButton copied onCopy={() => undefined} label={text(context).copy} copiedLabel={text(context).copied} />
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active"],
  render: (context) => <CopyButton text="copy" label={text(context).copy} copiedLabel={text(context).copied} />,
};
