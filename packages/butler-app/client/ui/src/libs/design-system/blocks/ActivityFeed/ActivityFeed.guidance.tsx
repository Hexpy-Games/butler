import type { ShowcaseGuidance } from "../../showcase";
import { CheckIcon, Circle } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ActivityFeed } from "./ActivityFeed";

// #region recipe: Summary progress
function SummaryProgress() {
  return (
    <ActivityFeed title="Progress" emptyLabel="No progress yet." items={[
      { id: "1", icon: <CheckIcon size="md" />, title: "Read the settings pages" },
      { id: "2", icon: <Circle size="md" />, title: "Write the report" },
    ]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A titled list of activity items whose icons align with the first title line.",
  whenToUse: ["Progress or recent activity in the inspector"],
  whenNotToUse: [
    { when: "Automation run history", use: "AutomationRunList" },
    { when: "Tool calls inside a turn", use: "WorkActivityBlock" },
  ],
  recipes: [{ name: "Summary progress", description: "State icons per item; emptyLabel when nothing happened.", render: () => <SummaryProgress /> }],
  doDont: [
    {
      do: { caption: "Icons align with titles even when descriptions wrap.", render: () => <SummaryProgress /> },
      dont: { caption: "Hand-built rows drift the icon from the title baseline.", render: () => <Stack align="row" gap="sm" cross="center"><CheckIcon size="md" /><Typo.Body>Read the settings pages and the tokens</Typo.Body></Stack> },
    },
  ],
  content: ["Past tense for done items, imperative for pending ones."],
  accessibility: ["A list with a heading; icons are decorative, the title states the item."],
  tokens: ["--icon-size-md", "--text-secondary", "--space-sm"],
};
