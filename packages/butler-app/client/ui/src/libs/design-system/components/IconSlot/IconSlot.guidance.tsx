import type { ShowcaseGuidance } from "../../showcase";
import { Briefcase, CircleAlert } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { IconSlot } from "./IconSlot";

// #region recipe: Row glyph and status
function RowGlyph() {
  return (
    <Stack align="row" cross="center" gap="sm">
      <IconSlot size="sidebar"><Briefcase /></IconSlot>
      <Typo.Text grow truncate>Butler site</Typo.Text>
      <IconSlot size="sidebar" minHeight="line" passive role="status" aria-label="Needs attention"><CircleAlert /></IconSlot>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A fixed square that centers one glyph so rows, status marks and markers line up.",
  whenToUse: ["A glyph that must keep its column width (row glyphs, status marks, timeline markers)"],
  whenNotToUse: [
    { when: "A clickable icon", use: "IconButton" },
    { when: "An icon that swaps to a toggle on hover", use: "GlyphToggle" },
  ],
  recipes: [{ name: "Row glyph and status", description: "size=\"sidebar\" follows the sidebar density; status marks take role=\"status\" and a label.", render: () => <RowGlyph /> }],
  doDont: [
    {
      do: { caption: "Glyphs keep one column width across rows.", render: () => <RowGlyph /> },
      dont: { caption: "A bare icon shifts the label by the glyph's own width.", render: () => <Stack align="row" gap="sm"><CircleAlert /><Typo.Text>Butler site</Typo.Text></Stack> },
    },
  ],
  content: ["Status marks carry a label (Working, Needs attention)."],
  accessibility: ["Decorative glyphs stay unlabelled; status marks use role=\"status\" with aria-label."],
  tokens: ["--icon-size-md", "--sidebar-icon-size"],
};
