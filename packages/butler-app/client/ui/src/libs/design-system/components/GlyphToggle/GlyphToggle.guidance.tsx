import type { ShowcaseGuidance } from "../../showcase";
import { Briefcase, Sparkles } from "../Icons";
import { IconButton } from "../IconButton";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { GlyphToggle } from "./GlyphToggle";

// #region recipe: Pin a sidebar row
function PinRow() {
  return (
    <Stack align="row" cross="center" gap="sm">
      <GlyphToggle glyph={<Briefcase />} toggleGlyph={<Sparkles fill="none" />} pressed={false} label="Butler site Pin"
        onClick={(event) => event.stopPropagation()} />
      <Typo.Text truncate>Butler site</Typo.Text>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A row glyph that doubles as a pin toggle: the glyph keeps its column, the toggle glyph shows on hover and focus.",
  whenToUse: ["Pin or favorite a sidebar row without adding a trailing action"],
  whenNotToUse: [
    { when: "A standalone icon action", use: "IconButton" },
    { when: "A static glyph", use: "IconSlot" },
  ],
  recipes: [{ name: "Pin a sidebar row", description: "Stop propagation so the row does not open; the label carries the state.", render: () => <PinRow /> }],
  doDont: [
    {
      do: { caption: "The glyph column stays put; the hit target stays full size.", render: () => <PinRow /> },
      dont: { caption: "A trailing pin button crowds the row actions.", render: () => <Stack align="row" gap="sm"><Typo.Text>Butler site</Typo.Text><IconButton label="Pin"><Sparkles /></IconButton></Stack> },
    },
  ],
  content: ["The label names the row and the action (Butler site Pin / Unpin)."],
  accessibility: ["aria-pressed reflects the state; the toggle glyph also shows on keyboard focus."],
  tokens: ["--sidebar-icon-size", "--control-hit-target"],
};
