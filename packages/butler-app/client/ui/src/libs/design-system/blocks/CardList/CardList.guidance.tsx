import type { ShowcaseGuidance } from "../../showcase";
import { Sparkles } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { SettingsPage, SettingsSection } from "../SettingsSection";
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

// #region recipe: Rows in a settings section
function SettingsSkills() {
  return (
    <SettingsPage>
      <SettingsSection id="g-skills" kind="list" title="Your skills">
        <CardList>
          <CardListItem icon={<Sparkles />} title="project-ledger" description="Inspect and validate project records." />
          <CardListItem icon={<Sparkles />} title="butler-design-system" description="Assemble UI only from the DS." />
        </CardList>
      </SettingsSection>
    </SettingsPage>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A list of item cards (skills, MCP servers) with a title, empty state and a scroll cap; flush rows divided by hairlines inside a settings section card.",
  whenToUse: ["A settings list of configured things with per-item actions"],
  whenNotToUse: [
    { when: "Reordering by drag", use: "SortableCardList" },
    { when: "Rows inside a panel", use: "ListRow" },
  ],
  recipes: [
    { name: "Skills list with a row cap", description: "maxVisibleRows scrolls long lists; empty renders when there are no children.", render: () => <SkillsList /> },
    { name: "Rows in a settings section", description: "Inside a section card the rows render flush (no nested cards); the section owns the title and the empty state.", render: () => <SettingsSkills /> },
  ],
  doDont: [
    {
      do: { caption: "One CardList per collection, with an empty state.", render: () => <SkillsList /> },
      dont: { caption: "Stacked panels repeat borders and never show an empty state.", render: () => <Stack gap="sm"><SurfacePanel><Typo.Body>project-ledger</Typo.Body></SurfacePanel><SurfacePanel><Typo.Body>butler-design-system</Typo.Body></SurfacePanel></Stack> },
    },
  ],
  content: [
    "Titles are identifiers as configured; descriptions say what the item does.",
    "Row actions (a menu, buttons, the row's own toggle) sit at the line end and center on the title's line.",
    "A labelled switch inside an item's description uses the row switch field (Field orientation=\"horizontal\").",
    "Inside a settings section, leave title and empty unset: the section title names the list and its empty state is the only one.",
  ],
  accessibility: ["Items are list items; selected items expose it; actions are labelled buttons."],
  tokens: ["--line", "--radius-panel", "--selection", "--space-sm"],
};
