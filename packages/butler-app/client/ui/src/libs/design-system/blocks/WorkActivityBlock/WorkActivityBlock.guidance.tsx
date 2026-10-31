import { useId, useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../../components/Card";
import { Stack } from "../../components/Stack";
import { Search, Terminal } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { ScrollArea } from "../ScrollArea";
import { WorkActivityBlock, WorkActivityDisclosure, WorkActivityOutput, WorkActivityToolGroup } from "./index";

// #region recipe: Turn work with tools and output
function TurnWork() {
  return (
    <WorkActivityBlock title="Checking the current state with local commands" description="Collect evidence first, then report." running connected
      tools={[
        { id: "search", icon: <Search size="md" />, title: "Search: SettingsSection", summaryLabel: "Search" },
        { id: "bash", icon: <Terminal size="md" />, title: "Bash: bun run app:layout:smoke", summaryLabel: "Bash", after: <WorkActivityOutput>layout smoke: ok</WorkActivityOutput> },
      ]} />
  );
}
// #endregion

// #region recipe: Grouped tool calls
function GroupedTools() {
  return (
    <WorkActivityToolGroup tools={[
      { id: "a", icon: <Search size="md" />, title: "Search: tokens.css", summaryLabel: "Search" },
      { id: "b", icon: <Search size="md" />, title: "Search: motion.ts", summaryLabel: "Search" },
    ]} />
  );
}
// #endregion

// #region recipe: Folded work timeline
function FoldedTimeline() {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const steps = ["Recall the conversation", "Check prices", "Compare performance"];
  return (
    <WorkActivityDisclosure status="Working" latest="Compare performance · Web search" previous="Check prices"
      hiddenCount={2} live expanded={expanded} onToggle={() => setExpanded((value) => !value)}
      label="Working, Compare performance · Web search, 2 earlier records" detailsId={detailsId} detailsLabel="Price research details">
      <ScrollArea maxHeight="sm">
        <Stack as="ol" gap="sm">
          {steps.map((step, index) => (
            <li key={step}><WorkActivityBlock density="compact" title={step} connected={index < 2} live={index === 2} /></li>
          ))}
        </Stack>
      </ScrollArea>
    </WorkActivityDisclosure>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The backgroundless timeline of a turn's work: title, description, tool rows (grouped) and safe output. WorkActivityDisclosure folds a long timeline to its tail.",
  whenToUse: [
    "Show what the assistant did or is doing inside a turn",
    "WorkActivityDisclosure: a work card whose full timeline opens in place, collapsed to the latest activity",
  ],
  whenNotToUse: [
    { when: "Worker sub-sessions", use: "WorkerActivityRow" },
    { when: "A one-line live status", use: "RollingStatusLine" },
  ],
  recipes: [
    { name: "Turn work with tools and output", description: "connected draws the guide line; WorkActivityOutput shows a safe summary.", render: () => <TurnWork /> },
    { name: "Grouped tool calls", description: "Several calls fold into one expandable group row.", render: () => <GroupedTools /> },
    { name: "Folded work timeline", description: "Collapsed: status line plus the timeline tail (faded previous row, live latest row, \"+N ›\") as one button. Expanded: the tail folds away and only the full timeline remains.", render: () => <FoldedTimeline /> },
  ],
  doDont: [
    {
      do: { caption: "Timeline rows without a card background.", render: () => <TurnWork /> },
      dont: { caption: "Work progress in filled cards reads like a separate feature.", render: () => <Card><Typo.Body>Checking the current state</Typo.Body></Card> },
    },
  ],
  content: [
    "Titles say what is being done; tool titles are Tool: target.",
    "Set live on one row only: the newest activity of work that is still running. Completed work has no live row.",
    "WorkActivityDisclosure: status is the run state only; latest is the newest activity on one line; previous is that activity's predecessor (a hint, not a second summary).",
  ],
  accessibility: [
    "Groups expose aria-expanded; output is text, never raw terminal control sequences.",
    "A tool row with details puts its chevron directly after the title, never at the row's far edge; only the title truncates.",
    "WorkActivityDisclosure: the status line and tail are one button with aria-expanded and aria-controls; its label names the status, the latest activity and the earlier record count, because the tail itself is aria-hidden.",
    "Collapsed the toggle is the status plus tail (66px desktop, 74px phone); expanded its hit strip stays at --control-hit-target. The text focus ring sits 4px off the text, inside the card padding.",
    "The live pulse stops under reduced motion (--motion-loop-count 0); the dot stays filled.",
  ],
  tokens: ["--line", "--line-strong", "--icon-size-md", "--motion-base", "--motion-exit-base", "--motion-live-pulse", "--motion-loop-count", "--control-hit-target", "--tag-height-sm"],
};
