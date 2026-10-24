import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/Select";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { tagLabelToneNames } from "../../components/Tag/Tag.demo";
import type { TagLabelTone } from "../../components/Tag/tagTones";
import { TagColorSwatches } from "./TagColorSwatches";

// #region recipe: Color for a new tag
function NewTagColor() {
  const [tone, setTone] = useState<TagLabelTone>("blue");
  return (
    <Stack gap="sm">
      <TagColorSwatches ariaLabel="Color" labels={tagLabelToneNames["en-US"]} value={tone} onValueChange={setTone} />
      <Tag tone={tone}>design</Tag>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Picks a Tag label tone from round swatches, each a miniature of the Tag it makes.",
  whenToUse: ["Choosing the color of a user's tag or label when creating or editing it"],
  whenNotToUse: [
    { when: "Any color value (a wallpaper ink, a hex)", use: "ColorSwatchInput" },
    { when: "A choice between named options", use: "SegmentedControl" },
  ],
  recipes: [{ name: "Color for a new tag", description: "Show the Tag beside the swatches so the choice is previewed.", render: () => <NewTagColor /> }],
  doDont: [
    {
      do: { caption: "Swatches for a label tone, previewed on the Tag.", render: () => <NewTagColor /> },
      dont: {
        caption: "A select of color names hides the colors.",
        render: () => (
          <Select defaultValue="blue">
            <SelectTrigger aria-label="Color"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="blue">Blue</SelectItem></SelectContent>
          </Select>
        ),
      },
    },
  ],
  content: ["labels names every tone in the product's language (\"Blue\", \"파랑\"); the DS has no copy of its own.",
    "Store the tone name the swatch returns, never a color value.", "tones narrows or reorders the set; default is every label tone."],
  accessibility: ["A radiogroup named by ariaLabel; each swatch is a radio named by its label, which is also its tooltip.",
    "Arrow keys move and select, Home and End jump; only the chosen swatch is in the tab order.",
    "Selection is a ring plus a check, so it never rests on color alone; rings draw inside the swatch, so no clipping container cuts them."],
  tokens: ["--tag-label-blue-bg", "--tag-label-blue-fg", "--tag-label-blue-border", "--control-height-sm", "--control-hit-target", "--focus-ring-width", "--text-primary"],
};
