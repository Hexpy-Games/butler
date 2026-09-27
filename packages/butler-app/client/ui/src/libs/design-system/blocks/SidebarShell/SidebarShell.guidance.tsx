import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../../components/Stack";
import { PencilLine, Search, Settings } from "../../components/Icons";
import { NavRow } from "../NavRow";
import { SidebarNav, SidebarShell, SidebarTrafficSpace } from "./SidebarShell";

// #region recipe: Sidebar with fixed nav and a scrolling list
function Sidebar() {
  return (
      <SidebarShell ariaLabel="Sidebar" titlebar={<SidebarTrafficSpace />} footer={<NavRow icon={<Settings />} label="Settings" />}
        scrollHeader={(
          <SidebarNav ariaLabel="Sidebar">
            <NavRow icon={<PencilLine />} label="New chat" active />
            <NavRow icon={<Search />} label="Search" />
          </SidebarNav>
        )}>
        {["Desktop client polish", "Weekly review", "Release notes"].map((label) => <NavRow key={label} label={label} />)}
      </SidebarShell>
  );
}
// #endregion

/** Viewer frame only: the shell fills its parent's height. */
function Framed() {
  return <div style={{ height: 300 }}><Sidebar /></div>;
}

export const guidance: ShowcaseGuidance = {
  purpose: "The sidebar frame: titlebar space, fixed navigation, a scrolling list with fades, a footer and a density.",
  whenToUse: ["The app sidebar and other sidebar-like navigation columns"],
  whenNotToUse: [
    { when: "Settings navigation lists", use: "SettingsNav" },
    { when: "A scrolling region in content", use: "ScrollArea" },
  ],
  recipes: [{ name: "Sidebar with fixed nav and a scrolling list", description: "Only sessions scroll; direct navigation and the footer stay put.", render: () => <Framed /> }],
  doDont: [
    {
      do: { caption: "Density is set once on the shell; rows follow it.", render: () => <Framed /> },
      dont: { caption: "A plain Stack sidebar scrolls the navigation away.", render: () => <Stack gap="xs"><NavRow label="New chat" /><NavRow label="Desktop client polish" /></Stack> },
    },
  ],
  content: ["SidebarBrand shows the product or workspace name only."],
  accessibility: ["ariaLabel names the navigation landmarks; the scrolling list keeps fades out of the scrollbar."],
  tokens: ["--sidebar-bg", "--sidebar-width", "--sidebar-row-height", "--scroll-fade-size", "--sidebar-padding-inline"],
};
