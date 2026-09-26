import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Input } from "../../components/Input";
import { TokenInputControl } from "./TokenInputControl";

// #region recipe: Topic tokens
function Topics() {
  const [value, setValue] = useState("typescript, design-system");
  const tokens = value.split(",").map((token) => token.trim()).filter(Boolean);
  return <TokenInputControl id="topics" value={value} tokens={tokens} onChange={setValue} placeholder="Add topics, separated by commas" />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A comma-separated text input that previews its values as tokens.",
  whenToUse: ["A short list of free-form values (topics, tags)"],
  whenNotToUse: [
    { when: "One value", use: "Input" },
    { when: "Values from a fixed list", use: "Select" },
  ],
  recipes: [{ name: "Topic tokens", description: "The caller parses the text into tokens; the control shows them.", render: () => <Topics /> }],
  doDont: [
    {
      do: { caption: "Tokens show how the text will be split.", render: () => <Topics /> },
      dont: { caption: "A plain input hides how commas are interpreted.", render: () => <Input aria-label="Topics" defaultValue="typescript, design-system" /> },
    },
  ],
  content: ["The placeholder names the separator."],
  accessibility: ["Pass inputProps.aria-label when there is no visible label."],
  tokens: ["--radius-pill", "--line", "--space-xs"],
};
