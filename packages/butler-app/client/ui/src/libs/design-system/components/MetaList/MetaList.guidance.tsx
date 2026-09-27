import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { MetaList } from "./MetaList";

// #region recipe: Usage metadata under a title
function UsageMeta() {
  return (
    <Stack gap="xs">
      <Typo.Body>Conversation</Typo.Body>
      <MetaList items={[{ label: "Input", value: "36,460" }, { label: "Cache", value: "8,200" }, { label: "Output", value: "4,420" }]} />
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A compact inline run of label/value facts separated by dots, as a description list.",
  whenToUse: ["Two to five short facts under a title (usage, plan, source)"],
  whenNotToUse: [
    { when: "Facts that need their own rows", use: "KeyValueRow" },
    { when: "A single caption", use: "Typo.Caption" },
  ],
  recipes: [{ name: "Usage metadata under a title", description: "Values use tabular figures; labels stay quiet.", render: () => <UsageMeta /> }],
  doDont: [
    {
      do: { caption: "MetaList keeps label/value pairs semantic (dl).", render: () => <UsageMeta /> },
      dont: { caption: "A joined string loses structure and alignment.", render: () => <Typo.Caption>Input 36,460 · Cache 8,200 · Output 4,420</Typo.Caption> },
    },
  ],
  content: ["Labels are one word; values are formatted numbers or short words."],
  accessibility: ["Rendered as a description list so pairs are announced together."],
  tokens: ["--text-secondary", "--typo-caption-size", "--space-xs"],
};
