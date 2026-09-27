import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Input } from "../../components/Input";
import { Typo } from "../../components/Typo";
import { ListRow } from "../ListRow";
import { CommandPanel } from "./CommandPanel";

// #region recipe: Inline command search
function InlineCommands() {
  const [query, setQuery] = useState("");
  const results = ["Appearance settings", "Weekly review", "New project"].filter((item) => item.toLowerCase().includes(query.toLowerCase()));
  return (
    <CommandPanel query={query} onQueryChange={setQuery} placeholder="Search chats, projects and settings">
      {results.map((item) => <ListRow key={item} title={item} />)}
    </CommandPanel>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Command search: CommandPalettePanel is the Cmd+K dialog; CommandPanel is the inline search surface.",
  whenToUse: ["Global search and commands on Cmd+K (CommandPalettePanel)", "An embedded search-and-results panel (CommandPanel)"],
  whenNotToUse: [
    { when: "Choosing a value for one field", use: "FilteredSelectPopover" },
    { when: "Filtering a single list in place", use: "Input" },
  ],
  recipes: [{ name: "Inline command search", description: "Query in, results as children; the palette variant adds the dialog and keyboard list.", render: () => <InlineCommands /> }],
  doDont: [
    {
      do: { caption: "One search surface for everything reachable.", render: () => <InlineCommands /> },
      dont: { caption: "A bare input with no results surface leaves people guessing.", render: () => <><Input aria-label="Search" placeholder="Search" /><Typo.Caption tone="tertiary">No results area</Typo.Caption></> },
    },
  ],
  content: ["The placeholder lists what can be found; feedback explains empty results."],
  accessibility: ["Palette: combobox with aria-activedescendant, arrows and Enter; Escape closes; IME composition never toggles it."],
  tokens: ["--command-overlay-bg", "--motion-palette", "--motion-scale-palette", "--radius-popover"],
};
