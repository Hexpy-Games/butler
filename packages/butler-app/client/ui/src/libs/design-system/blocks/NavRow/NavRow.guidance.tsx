import type { ShowcaseGuidance } from "../../showcase";
import { Clickable } from "../../components/Clickable";
import { Folder, Notebook } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { OverflowActionMenu } from "../OverflowActionMenu";
import { SidebarShell } from "../SidebarShell";
import { NavRow } from "./NavRow";
import { NavRowSwap } from "./NavRowSwap";

// #region recipe: Sidebar row with hover actions
function SessionNavRow() {
  return (
    <SidebarShell ariaLabel="Sidebar">
      <NavRow icon={<Notebook size="md" />} label="Token page review" onClick={() => undefined} actions={(
        <NavRowSwap>
          <OverflowActionMenu label="Session actions" items={[{ label: "Rename", onSelect: () => undefined }]} />
        </NavRowSwap>
      )} />
    </SidebarShell>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The navigation row: icon and label on the left, badge or actions on the right, flat active state.",
  whenToUse: ["Rows in the sidebar, settings navigation and other navigation lists", "A row with hover-revealed actions"],
  whenNotToUse: [
    { when: "A data row that is not navigation", use: "ListRow" },
    { when: "A folder that expands", use: "CollapsibleNavGroup" },
    { when: "A generic clickable surface", use: "Clickable" },
  ],
  recipes: [{ name: "Sidebar row with hover actions", description: "In the SidebarShell, NavRowSwap reveals the row menu on hover and focus in place of the row's rest status.", render: () => <SessionNavRow /> }],
  doDont: [
    {
      do: { caption: "The active row is a flat selection fill.", render: () => <NavRow icon={<Folder size="md" />} label="butler" active onClick={() => undefined} /> },
      dont: {
        caption: "A Clickable row loses NavRow's regions, truncation and density.",
        render: () => <Clickable onClick={() => undefined}><Stack align="row" gap="sm"><Folder size="md" /><Typo.Body>butler</Typo.Body></Stack></Clickable>,
      },
    },
  ],
  content: ["windowDrag=\"no-drag\" keeps a row clickable inside a titlebar drag region.", "Labels are titles as the user named them; truncate, never wrap, unless multiline is set."],
  accessibility: ["Active rows carry aria-current; actions stop propagation; iconInteractive exposes an icon control."],
  tokens: ["--sidebar-row-height", "--selection-strong", "--selection", "--sidebar-action-size", "--motion-fast"],
};
