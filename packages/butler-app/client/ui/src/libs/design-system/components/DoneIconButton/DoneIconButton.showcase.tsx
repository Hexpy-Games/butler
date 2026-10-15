import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { CopyButton } from "../CopyButton";
import { Library } from "../Icons";
import { Inline } from "../Inline";
import { DoneIconButton } from "./DoneIconButton";

export const meta: ShowcaseMeta = {
  title: "DoneIconButton",
  category: "Action",
  tags: ["action", "save", "library", "confirm", "check", "motion", "feedback"],
  status: "beta",
};

const labels = {
  "en-US": { save: "Save to library", saved: "Saved to library", copy: "Copy", copied: "Copied" },
  "ko-KR": { save: "서랍에 저장", saved: "서랍에 저장했어요", copy: "복사", copied: "복사했어요" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** A stand-in for the container's save: it settles after a short round trip. */
const save = () => new Promise<void>((resolve) => setTimeout(resolve, 300));
const failingSave = () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error("save_failed")), 300));

export const stories: ShowcaseStory[] = [
  {
    name: "Save and confirm",
    states: ["done"],
    render: (context) => (
      <Inline gap="sm">
        <DoneIconButton icon={<Library size="sm" />} label={text(context).save} doneLabel={text(context).saved} onAction={save} />
        <CopyButton text="Butler copied this item." label={text(context).copy} copiedLabel={text(context).copied} />
      </Inline>
    ),
  },
  {
    name: "Done state",
    states: ["done"],
    render: (context) => <DoneIconButton done icon={<Library size="sm" />} label={text(context).save} doneLabel={text(context).saved} />,
  },
  {
    name: "Failed action: no check",
    render: (context) => (
      <DoneIconButton icon={<Library size="sm" />} label={text(context).save} doneLabel={text(context).saved} onAction={failingSave} onError={() => undefined} />
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active"],
  render: (context) => <DoneIconButton icon={<Library size="sm" />} label={text(context).save} doneLabel={text(context).saved} onAction={save} />,
};
