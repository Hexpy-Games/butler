import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Stack } from "../Stack";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./Select";

export const meta: ShowcaseMeta = {
  title: "Select",
  category: "Input",
  tags: ["form", "selection"],
  status: "stable",
};

const labels = {
  "en-US": { choose: "Choose", one: "One", two: "Two" },
  "ko-KR": { choose: "선택", one: "하나", two: "둘" },
} as const;

function SelectExample({ locale, value }: ShowcaseRenderContext & { value?: string }) {
  const text = labels[locale];
  return (
    <Select defaultValue={value}>
      <SelectTrigger aria-label={value ? "Selected value" : "Placeholder select"}>
        <SelectValue placeholder={text.choose} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="one">{text.one}</SelectItem>
        <SelectItem value="two">{text.two}</SelectItem>
      </SelectContent>
    </Select>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Default",
    render: ({ locale }) => (
      <Stack align="row" gap="sm" wrap>
        <SelectExample locale={locale} value="one" />
        <SelectExample locale={locale} />
      </Stack>
    ),
  },
  {
    name: "Disabled",
    states: ["disabled"],
    render: ({ locale }) => (
      <Select disabled defaultValue="one">
        <SelectTrigger aria-label="Disabled select">
          <SelectValue placeholder={labels[locale].choose} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one">{labels[locale].one}</SelectItem>
        </SelectContent>
      </Select>
    ),
  },
];
