import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { OnWallpapers, tagLabelToneNames } from "../../components/Tag/Tag.demo";
import type { TagLabelTone } from "../../components/Tag/tagTones";
import { TagColorSwatches } from "./TagColorSwatches";

export const meta: ShowcaseMeta = {
  title: "TagColorSwatches",
  category: "Settings & Forms",
  tags: ["tag", "color", "swatch", "tone", "label", "picker"],
  status: "stable",
};

const copy = {
  "en-US": { color: "Color", tag: "design" },
  "ko-KR": { color: "색", tag: "디자인" },
} as const;

/** A new tag's color: the swatches and the Tag they restyle. */
function Picker({ locale, initial = "blue" }: ShowcaseRenderContext & { initial?: TagLabelTone }) {
  const [tone, setTone] = useState<TagLabelTone>(initial);
  return (
    <Stack gap="sm">
      <TagColorSwatches ariaLabel={copy[locale].color} labels={tagLabelToneNames[locale]} value={tone} onValueChange={setTone} />
      <Tag tone={tone}>{copy[locale].tag}</Tag>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Pick a tone", widths: ["app", "320"], render: (context) => <Picker {...context} /> },
  { name: "Fewer tones", render: ({ locale }) => (
    <TagColorSwatches ariaLabel={copy[locale].color} labels={tagLabelToneNames[locale]} tones={["gray", "red", "green", "blue"]}
      value="green" onValueChange={() => undefined} />
  ) },
  { name: "On wallpaper", widths: ["app", "375"], render: (context) => <OnWallpapers><Picker {...context} initial="teal" /></OnWallpapers> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active"],
  render: ({ locale }) => (
    <TagColorSwatches ariaLabel={copy[locale].color} labels={tagLabelToneNames[locale]} tones={["gray", "blue", "purple"]}
      value="purple" onValueChange={() => undefined} />
  ),
};
