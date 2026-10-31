import type { ShowcaseGuidance } from "../../showcase";
import { Clickable } from "../../components/Clickable";
import { Folder, Notebook } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { OverflowActionMenu } from "../OverflowActionMenu";
import { SidebarShell } from "../SidebarShell";
import { NavRow } from "./NavRow";
import { NavRowChildren } from "./NavRowChildren";
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

// #region recipe: Nested rows under a row
function NestedNavRows() {
  return (
    <SidebarShell ariaLabel="Sidebar">
      <NavRow icon={<Notebook size="md" />} label="Find the sign-in error" onClick={() => undefined} />
      <NavRowChildren>
        <NavRow reserveIcon label="Review the token refresh logic" onClick={() => undefined} />
        <NavRow reserveIcon label="Tidy the regression tests" onClick={() => undefined} />
      </NavRowChildren>
    </SidebarShell>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The navigation row: icon and label on the left, badge or actions on the right, flat active state.",
  whenToUse: ["Rows in the sidebar, settings navigation and other navigation lists", "A row with hover-revealed actions", "Rows that belong to the row above (a chat's subtasks): NavRowChildren"],
  whenNotToUse: [
    { when: "A data row that is not navigation", use: "ListRow" },
    { when: "A folder that expands", use: "CollapsibleNavGroup" },
    { when: "A generic clickable surface", use: "Clickable" },
  ],
  recipes: [
    { name: "Sidebar row with hover actions", description: "In the SidebarShell, NavRowSwap reveals the row menu on hover and focus in place of the row's rest status.", render: () => <SessionNavRow /> },
    { name: "Nested rows under a row", description: "NavRowChildren joins rows to the row above with a guide line on its icon column; reserveIcon lines their labels up with the parent's.", render: () => <NestedNavRows /> },
  ],
  doDont: [
    {
      do: { caption: "The active row is a flat fill from the surface's family.", render: () => <NavRow icon={<Folder size="md" />} label="butler" active onClick={() => undefined} /> },
      dont: {
        caption: "A Clickable row loses NavRow's regions, truncation and density.",
        render: () => <Clickable onClick={() => undefined}><Stack align="row" gap="sm"><Folder size="md" /><Typo.Body>butler</Typo.Body></Stack></Clickable>,
      },
    },
  ],
  content: ["NavRowChildren places its guide line from the density's row inset and icon size; never offset or redraw it in product code.",
    "Fills follow the sidebar surface, never the platform: a tinted shell (light macOS or Windows translucent, the opaque sidebar setting) takes the white family; a white base (web and Linux translucent, the peek card, the drawer) and dark keep the --selection shades.",
    "Fills stay flat: no motion between rows, no shadow or edge. Selected + hover and pressed show the selected fill; the medium label weight marks selection where hover is faint.",
    "windowDrag=\"no-drag\" keeps a row clickable inside a titlebar drag region.", "Labels are titles as the user named them; truncate, never wrap, unless multiline is set."],
  accessibility: ["Active rows carry aria-current; actions stop propagation; iconInteractive exposes an icon control."],
  tokens: ["--sidebar-row-height", "--selection-strong", "--selection", "--mac-sidebar-hover-bg", "--mac-sidebar-selected-bg",
    "--windows-sidebar-hover-bg", "--windows-sidebar-selected-bg", "--sidebar-action-size", "--motion-fast",
    "--sidebar-row-padding-inline", "--sidebar-icon-size", "--line"],
};
