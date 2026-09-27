import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Kbd } from "./Kbd";

// #region recipe: Search hint
function SearchHint() {
  return (
    <Stack align="row" cross="center" gap="xs">
      <Kbd keys={["⌘", "K"]} label="Command K" />
      <Typo.Caption tone="secondary">search anything</Typo.Caption>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Key caps for a keyboard shortcut, one <kbd> per key inside a combination.",
  whenToUse: ["Teach a shortcut next to the control or in a hint"],
  whenNotToUse: [
    { when: "The shortcut column of a menu item", use: "DropdownMenuShortcut" },
    { when: "Code or a command name", use: "Typo.Code" },
  ],
  recipes: [{ name: "Search hint", description: "A short hint beside the key caps; label spells out symbols.", render: () => <SearchHint /> }],
  doDont: [
    {
      do: { caption: "Key caps make shortcuts scannable.", render: () => <SearchHint /> },
      dont: { caption: "Shortcuts in plain text blend into the sentence.", render: () => <Typo.Caption>Press Cmd+K to search</Typo.Caption> },
    },
  ],
  content: ["Use platform glyphs on macOS (⌘, ⇧) and words elsewhere (Ctrl)."],
  accessibility: ["Pass label for symbol keys; the caps are then hidden from assistive technology."],
  tokens: ["--control-height-xs", "--line-strong", "--radius-control", "--typo-caption-size"],
};
