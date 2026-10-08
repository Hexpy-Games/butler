import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Briefcase, CircleAlert, Folder, MessageSquare } from "../Icons";
import { Spinner } from "../Spinner";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { IconSlot } from "./IconSlot";

export const meta: ShowcaseMeta = {
  title: "IconSlot",
  category: "Data display",
  tags: ["icon", "glyph", "status", "slot"],
  status: "beta",
};

const labels = {
  "en-US": { working: "Working", attention: "Needs attention", project: "Butler site" },
  "ko-KR": { working: "작업 중", attention: "확인 필요", project: "버틀러 사이트" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Sizes",
    render: () => (
      <Stack align="row" cross="center" gap="md">
        {(["xs", "sm", "md", "lg"] as const).map((size) => <IconSlot key={size} size={size}><Folder size={size} /></IconSlot>)}
      </Stack>
    ),
  },
  {
    name: "Row glyph and status mark",
    render: (context) => (
      <Stack align="row" cross="center" gap="sm">
        <IconSlot size="sidebar"><Briefcase /></IconSlot>
        <Typo.Text grow truncate>{text(context).project}</Typo.Text>
        <IconSlot size="sidebar" minHeight="line" passive role="status" aria-label={text(context).working}><Spinner /></IconSlot>
        <IconSlot size="sidebar" minHeight="line" passive role="status" aria-label={text(context).attention}><CircleAlert /></IconSlot>
        <IconSlot size="sidebar"><MessageSquare /></IconSlot>
      </Stack>
    ),
  },
];
