import type { ShowcaseGuidance } from "../../showcase";
import { Globe2, ShieldCheck } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { IconTile } from "./IconTile";

// #region recipe: Point with an icon tile
function ConsentPoint() {
  return (
    <Stack align="row" cross="start" gap="md">
      <IconTile size="sm" tone="accent"><ShieldCheck size="md" /></IconTile>
      <Stack gap="none">
        <Typo.Label as="span" weight="semibold">Asks before changing anything</Typo.Label>
        <Typo.Caption tone="secondary">Butler asks before it edits files or runs commands.</Typo.Caption>
      </Stack>
    </Stack>
  );
}
// #endregion

// #region recipe: State glyph on a setup screen
function StateGlyph() {
  return (
    <Stack cross="center" gap="md">
      <IconTile size="lg"><Globe2 size="xl" /></IconTile>
      <Typo.H4 as="h2" align="center">Sign in with your browser</Typo.H4>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A rounded square that holds one glyph: a service logo, a point in a list, or the state of a setup screen.",
  whenToUse: ["A logo or icon that needs a quiet square behind it", "The state glyph of a setup or sign-in screen"],
  whenNotToUse: [
    { when: "A glyph in a row that only needs its column width", use: "IconSlot" },
    { when: "A clickable icon", use: "IconButton" },
  ],
  recipes: [
    { name: "Point with an icon tile", description: "An accent tile beside a title and one line of body.", render: () => <ConsentPoint /> },
    { name: "State glyph on a setup screen", description: "lg tile above the screen title.", render: () => <StateGlyph /> },
  ],
  doDont: [
    {
      do: { caption: "One glyph per tile, with text beside or below it.", render: () => <ConsentPoint /> },
      dont: { caption: "A tile with no text leaves people guessing.", render: () => <IconTile size="sm" tone="accent"><ShieldCheck size="md" /></IconTile> },
    },
  ],
  content: ["The tile is decorative; the neighbouring text says what it means."],
  accessibility: ["Always aria-hidden; never the only carrier of meaning."],
  tokens: ["--muted", "--line", "--color-info-bg", "--color-info-text", "--danger", "--radius-control", "--radius-popover"],
};
