import type { ShowcaseGuidance } from "../../showcase";
import { Palette, Settings } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { NavRow } from "../NavRow";
import { SettingsNav } from "./SettingsNav";

// #region recipe: Settings navigation group
function AppGroup() {
  return (
    <SettingsNav title="App" items={[
      { id: "general", label: "General", icon: <Settings size="md" />, active: true, onSelect: () => undefined },
      { id: "appearance", label: "Appearance", icon: <Palette size="md" />, onSelect: () => undefined },
    ]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A titled group of settings sections as navigation rows, from an items array.",
  whenToUse: ["The settings sidebar, one SettingsNav per group"],
  whenNotToUse: [
    { when: "The app sidebar", use: "SidebarShell" },
    { when: "Rows with custom content", use: "NavRow" },
  ],
  recipes: [{ name: "Settings navigation group", description: "One active item across all groups.", render: () => <AppGroup /> }],
  doDont: [
    {
      do: { caption: "Items as data keep every group consistent.", render: () => <AppGroup /> },
      dont: { caption: "Hand-built rows drift in icon size and active style.", render: () => <Stack gap="xs"><NavRow label="General" active /><NavRow label="Appearance" /></Stack> },
    },
  ],
  content: ["Section names match the page titles exactly."],
  accessibility: ["Active items set aria-current; badges are text (a number), not color only."],
  tokens: ["--sidebar-row-height", "--selection-strong", "--typo-section-title-size"],
};
