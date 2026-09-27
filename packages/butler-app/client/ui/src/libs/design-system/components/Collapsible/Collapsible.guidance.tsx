import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Collapsible, CollapsibleList } from "./index";

// #region recipe: Show more details
function MoreDetails() {
  const [open, setOpen] = useState(false);
  return (
    <Stack gap="sm">
      <Button size="sm" variant="borderless" aria-expanded={open} text={open ? "Hide details" : "Show details"} onClick={() => setOpen(!open)} />
      <Collapsible open={open}>
        <Typo.Body>Command output is shown only as a safe summary.</Typo.Body>
      </Collapsible>
    </Stack>
  );
}
// #endregion

// #region recipe: Animated list rows
function Rows() {
  const [rows, setRows] = useState(["General", "Release notes"]);
  return (
    <Stack gap="sm">
      <CollapsibleList scope="rows">
        {rows.map((row) => <Typo.Body key={row}>{row}</Typo.Body>)}
      </CollapsibleList>
      <Button size="sm" variant="outline" text="Add row" onClick={() => setRows([...rows, `Row ${rows.length + 1}`])} />
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Reveals and folds content with a height and opacity transition that respects reduced motion.",
  whenToUse: ["Expand details under a row or tool call", "Animate rows entering and leaving a list"],
  whenNotToUse: [
    { when: "A sidebar folder", use: "CollapsibleNavGroup" },
    { when: "A disclosure row with a title and chevron", use: "DisclosureRow" },
    { when: "Mount and unmount with a fade only", use: "Presence" },
  ],
  recipes: [
    { name: "Show more details", description: "The trigger owns aria-expanded; Collapsible owns the motion.", render: () => <MoreDetails /> },
    { name: "Animated list rows", description: "CollapsibleList reveals inserted rows and folds removed ones in place.", render: () => <Rows /> },
  ],
  doDont: [
    {
      do: { caption: "Collapsible animates height with interpolate-size, clipped.", render: () => <MoreDetails /> },
      dont: { caption: "Conditional rendering pops content in and shifts the page.", render: () => <Typo.Body>{"{open && <Details />}"}</Typo.Body> },
    },
  ],
  content: ["No copy of its own; the trigger label says what will appear."],
  accessibility: ["Closed content unmounts (or keepMounted=\"focusable\" keeps it reachable)."],
  tokens: ["--motion-base", "--motion-exit-base", "--motion-ease-standard"],
};
