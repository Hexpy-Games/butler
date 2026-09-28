import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { NativeSelect, NativeSelectOption } from "../../components/NativeSelect";
import { ProviderLogo } from "../../components/ProviderLogo";
import { Tag } from "../../components/Tag";
import { ChoiceCard, ChoiceCardList, ChoiceTile, ChoiceTileGrid } from "./ChoiceCard";

// #region recipe: Pick a service
function PickService() {
  return (
    <ChoiceCardList aria-label="Which AI should Butler use?">
      <ChoiceCard icon={<ProviderLogo name="openai" size="lg" />} title="ChatGPT" tag={<Tag tone="accent">No key needed</Tag>}
        description="Sign in with ChatGPT" onClick={() => undefined} />
      <ChoiceCard icon={<ProviderLogo name="claude" size="lg" />} title="Claude" description="Use an Anthropic API key" onClick={() => undefined} />
    </ChoiceCardList>
  );
}
// #endregion

// #region recipe: More choices in a grid
function MoreServices() {
  return (
    <ChoiceTileGrid>
      <ChoiceTile icon={<ProviderLogo name="grok" />} title="Grok" description="xAI API key" onClick={() => undefined} />
      <ChoiceTile icon={<ProviderLogo name="zai" />} title="Z.AI Coding Plan" description="Coding Plan key" onClick={() => undefined} />
      <ChoiceTile icon={<ProviderLogo name="opencode" />} title="OpenCode Go" description="OpenCode Go key" onClick={() => undefined} />
    </ChoiceTileGrid>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Big, recognizable choices: a row card or a grid tile with a logo, a name, a short description and its state.",
  whenToUse: ["Picking one service, model or option where logos and names help recognition", "A long tail of choices in an equal-size grid"],
  whenNotToUse: [
    { when: "Choosing a value inside a form", use: "Select" },
    { when: "Two to four short text options", use: "SegmentedControl" },
    { when: "A card that shows content, not a choice", use: "Card" },
  ],
  recipes: [
    { name: "Pick a service", description: "Rows for the well-known choices; the Tag names the easiest path.", render: () => <PickService /> },
    { name: "More choices in a grid", description: "Tiles are equal size at every width; a long name wraps to two lines.", render: () => <MoreServices /> },
  ],
  doDont: [
    {
      do: { caption: "Show services people recognize, with their logos.", render: () => <PickService /> },
      dont: { caption: "A select hides the names behind a click.", render: () => (
        <NativeSelect aria-label="Service" defaultValue="openai"><NativeSelectOption value="openai">ChatGPT</NativeSelectOption></NativeSelect>
      ) },
    },
    {
      do: { caption: "Keep tile names short enough for two lines.", render: () => <MoreServices /> },
      dont: { caption: "Do not squeeze choices into plain buttons.", render: () => <Button variant="outline">Z.AI Coding Plan</Button> },
    },
  ],
  content: [
    "Title: the service name people know (ChatGPT, not OpenAI OAuth). Description: what they need, in a few words.",
    "Tags are two or three words (No key needed, Free · Private).",
  ],
  accessibility: [
    "Each card is a button; the description is its aria-describedby. Loading sets aria-busy, unavailable sets aria-disabled.",
    "For single choice lists pass role=radiogroup on ChoiceCardList and role=radio with aria-checked on each card.",
  ],
  tokens: ["--control-bg", "--control-hover-bg", "--line", "--line-strong", "--accent", "--color-info-bg", "--danger-line-strong", "--radius-panel", "--focus-ring"],
};
