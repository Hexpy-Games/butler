import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Collapsible } from "../../components/Collapsible";
import { Wrench } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { DisclosureRow } from "./DisclosureRow";

// #region recipe: Expandable tool call
function ToolCall() {
  const [open, setOpen] = useState(false);
  return (
    <DisclosureRow icon={<Wrench size="md" />} title="Search" description="Project files" open={open} onToggle={() => setOpen(!open)}>
      <Typo.Caption>Read-only file search completed: 14 matches in 6 files.</Typo.Caption>
    </DisclosureRow>
  );
}
// #endregion

// #region recipe: Log list row
function LogRow() {
  const [open, setOpen] = useState(false);
  return (
    <DisclosureRow title="Send failed · 429 rate limited" meta="7.40s"
      description="14:06:19 · Model · Agent" open={open} onToggle={() => setOpen(!open)}>
      <Typo.Caption>Trace ID tr_01JB7R0C5K</Typo.Caption>
    </DisclosureRow>
  );
}
// #endregion

// #region recipe: Row that reveals sibling sections
function AdvancedRow() {
  const [open, setOpen] = useState(false);
  return (
    <Stack gap="sm">
      <DisclosureRow title="Memory cleanup model and worker settings" reveals controlsId="advanced-sections"
        open={open} onToggle={() => setOpen(!open)} />
      {open ? <Typo.Caption id="advanced-sections">Worker profiles</Typo.Caption> : null}
    </Stack>
  );
}
// #endregion

// #region recipe: Trace steps (static and interactive)
function TraceSteps() {
  const [open, setOpen] = useState(false);
  return (
    <Stack gap="none">
      <DisclosureRow affordance="none" title="Deliver" meta="18ms" description="+0.00s" />
      <DisclosureRow affordance="none" attention="error" count={1} title="Model request 1/3" meta="429 · 412ms"
        description="+0.17s" open={open} onToggle={() => setOpen(!open)}>
        <Typo.Caption>429 Rate limited · retry in 2s</Typo.Caption>
      </DisclosureRow>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A row with title, description and meta that expands details below it with the reveal motion; the open cue is a chevron directly after the title that turns down when open, or the row itself. A chevron never leads the title.",
  whenToUse: [
    "Tool calls, changed files, source details and log entries that expand",
    "Log lists: the chevron follows the title, and the level Tag and time end the first line as meta",
    "Settings pages: reveals marks a row that opens sibling sections instead of children",
    "Trace steps: affordance=\"none\" with a count of child steps, an attention dot on problem rows and a SpanBar in `bar`",
  ],
  whenNotToUse: [
    { when: "A sidebar folder", use: "CollapsibleNavGroup" },
    { when: "Expanding arbitrary content without a row", use: "Collapsible" },
  ],
  recipes: [
    { name: "Expandable tool call", description: "The caller owns open; surface=\"plain\" drops the selection fill.", render: () => <ToolCall /> },
    { name: "Log list row", description: "The chevron right after the title turns down when open; meta ends the line.", render: () => <LogRow /> },
    { name: "Row that reveals sibling sections", description: "No children: reveals makes it a disclosure with a chevron; controlsId names the region.", render: () => <AdvancedRow /> },
    { name: "Trace steps (static and interactive)", description: "affordance=\"none\": a row with nothing to reveal is static, with the same columns.", render: () => <TraceSteps /> },
  ],
  doDont: [
    {
      do: { caption: "The row states what expands before it opens.", render: () => <ToolCall /> },
      dont: { caption: "A bare Collapsible gives no title or icon alignment.", render: () => <Collapsible open><Typo.Caption>Details with no row</Typo.Caption></Collapsible> },
    },
    {
      do: { caption: "A step with nothing hidden is a static row: no hover, no focus stop.", render: () => <TraceSteps /> },
      dont: { caption: "A chevron on every trace step, even where nothing expands.", render: () => <DisclosureRow title="Deliver" meta="18ms" reveals onToggle={() => undefined} /> },
    },
  ],
  content: [
    "The chevron sits directly right of the title text (after any count), never before it and never at the far edge: a leading chevron pushes every row's content one column right.",
    "Title is the object (Search, file path); meta is a short count (+12 −3) or a status Tag with the duration.",
    "count is the number of direct child rows the row reveals: \"턴 실행 (8)\". attention marks problem rows only (error, warning); never on normal rows.",
  ],
  accessibility: [
    "The trigger has aria-expanded and aria-controls (controlsId); static rows are plain text, not focusable.",
    "The attention dot is aria-hidden: the meta or title must say what happened (429, 대기).",
    "Every row draws the focus ring inside the fill, so a clipping card or scroll frame never cuts it.",
    "The chevron turns without travel under reduced motion (app setting or OS).",
  ],
  tokens: [
    "--selection", "--motion-base", "--motion-fast", "--motion-ease-standard", "--icon-size-md", "--trace-error",
    "--trace-wait", "--focus-ring-width", "--focus-ring-color", "--space-lg", "--space-sm",
  ],
};
