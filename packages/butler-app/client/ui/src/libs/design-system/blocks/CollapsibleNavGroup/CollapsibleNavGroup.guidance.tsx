import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Folder, FolderOpen } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { NavRow } from "../NavRow";
import { CollapsibleNavGroup } from "./CollapsibleNavGroup";

// #region recipe: Folder with indented children
function ProjectFolder() {
  const [expanded, setExpanded] = useState(true);
  return (
    <CollapsibleNavGroup indented expanded={expanded} icon={expanded ? <FolderOpen size="md" /> : <Folder size="md" />}
      label="Design system" onToggle={() => setExpanded(!expanded)}>
      <NavRow label="Token pages" onClick={() => undefined} />
      <NavRow label="Motion trace" onClick={() => undefined} />
    </CollapsibleNavGroup>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A navigation folder: a header row that expands and folds its child rows with the DS reveal motion.",
  whenToUse: ["A project or folder in the sidebar tree", "Collapsible categories in a navigation list"],
  whenNotToUse: [
    { when: "A heading that never collapses", use: "NavSection" },
    { when: "Expanding details in content", use: "DisclosureRow" },
  ],
  recipes: [{ name: "Folder with indented children", description: "indented is the tree mode (Space); flat children match project groups.", render: () => <ProjectFolder /> }],
  doDont: [
    {
      do: { caption: "The folder icon shows the state; no caret chevron.", render: () => <ProjectFolder /> },
      dont: { caption: "Rows that pop in without the reveal shift the list abruptly.", render: () => <Stack gap="xs"><NavRow label="Design system" /><NavRow label="Token pages" /></Stack> },
    },
  ],
  content: ["Folder names as the user typed them."],
  accessibility: ["The header exposes aria-expanded; children unmount after the exit."],
  tokens: ["--sidebar-row-height", "--motion-base", "--motion-exit-base"],
};
