import type { ShowcaseGuidance } from "../../showcase";
import { Sparkles } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { SurfacePanel } from "../SurfacePanel";
import { CardList, CardListItem } from "./CardList";

// #region recipe: Skills list with a row cap
function SkillsList() {
  return (
    <CardList title="Project skills" maxVisibleRows={3} empty={<Typo.Caption>No skills yet.</Typo.Caption>}>
      <CardListItem icon={<Sparkles />} title="project-ledger" description="Inspect and validate project records." meta="core" />
      <CardListItem icon={<Sparkles />} title="butler-design-system" description="Assemble UI only from the DS." meta="project" />
    </CardList>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A bordered list of item cards (skills, MCP servers) with a title, empty state and a scroll cap.",
  whenToUse: ["A settings list of configured things with per-item actions"],
  whenNotToUse: [
    { when: "Reordering by drag", use: "SortableCardList" },
    { when: "Rows inside a panel", use: "ListRow" },
  ],
  recipes: [{ name: "Skills list with a row cap", description: "maxVisibleRows scrolls long lists; empty renders when there are no children.", render: () => <SkillsList /> }],
  doDont: [
    {
      do: { caption: "One CardList per collection, with an empty state.", render: () => <SkillsList /> },
      dont: { caption: "Stacked panels repeat borders and never show an empty state.", render: () => <Stack gap="sm"><SurfacePanel><Typo.Body>project-ledger</Typo.Body></SurfacePanel><SurfacePanel><Typo.Body>butler-design-system</Typo.Body></SurfacePanel></Stack> },
    },
  ],
  content: ["Titles are identifiers as configured; descriptions say what the item does."],
  accessibility: ["Items are list items; selected items expose it; actions are labelled buttons."],
  tokens: ["--line", "--radius-panel", "--selection", "--space-sm"],
};
