import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { Search } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Kbd } from "./Kbd";

export const meta: ShowcaseMeta = {
  title: "Kbd",
  category: "Data display",
  tags: ["keyboard", "shortcut", "hint", "cmd+k"],
  status: "beta",
};

const labels = {
  "en-US": { search: "Search", palette: "Command K", slash: "Slash", hint: "Press", toSearch: "to search, Esc to close.", send: "Send", enter: "Enter" },
  "ko-KR": { search: "검색", palette: "Command K", slash: "슬래시", hint: "누르면", toSearch: "검색하고, Esc로 닫습니다.", send: "보내기", enter: "Enter" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Shortcut hint",
    render: (context) => (
      <Stack align="row" cross="center" gap="xs" wrap>
        <Typo.Caption tone="secondary">{text(context).hint}</Typo.Caption>
        <Kbd keys={["⌘", "K"]} label={text(context).palette} />
        <Typo.Caption tone="secondary">{text(context).toSearch}</Typo.Caption>
      </Stack>
    ),
  },
  {
    // The DS Viewer search trigger: label, then the shortcut on the trailing edge.
    name: "Inside a button",
    render: (context) => (
      <Button variant="outline" iconStart={<Search size="md" />} iconEnd={<Kbd keys={["⌘", "K"]} label={text(context).palette} size="sm" />}
        text={text(context).search} />
    ),
  },
  {
    name: "Sizes and single keys",
    render: (context) => (
      <Stack align="row" cross="center" gap="md" wrap>
        <Kbd keys={["/"]} label={text(context).slash} />
        <Kbd keys={["Esc"]} />
        <Kbd keys={["⇧", "Enter"]} label={`Shift ${text(context).enter}`} size="sm" />
        <Kbd keys={["Ctrl", "K"]} size="sm" />
      </Stack>
    ),
  },
];
