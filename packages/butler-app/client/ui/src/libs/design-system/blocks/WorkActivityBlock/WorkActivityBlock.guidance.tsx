import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../../components/Card";
import { Search, Terminal } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { WorkActivityBlock, WorkActivityOutput, WorkActivityToolGroup } from "./index";

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

export const guidance: ShowcaseGuidance = {
  purpose: "The backgroundless timeline of a turn's work: title, description, tool rows (grouped) and safe output.",
  whenToUse: ["Show what the assistant did or is doing inside a turn"],
  whenNotToUse: [
    { when: "Worker sub-sessions", use: "WorkerActivityRow" },
    { when: "A one-line live status", use: "RollingStatusLine" },
  ],
  recipes: [
    { name: "Turn work with tools and output", description: "connected draws the guide line; WorkActivityOutput shows a safe summary.", render: () => <TurnWork /> },
    { name: "Grouped tool calls", description: "Several calls fold into one expandable group row.", render: () => <GroupedTools /> },
  ],
  doDont: [
    {
      do: { caption: "Timeline rows without a card background.", render: () => <TurnWork /> },
      dont: { caption: "Work progress in filled cards reads like a separate feature.", render: () => <Card><Typo.Body>Checking the current state</Typo.Body></Card> },
    },
  ],
  content: ["Titles say what is being done; tool titles are Tool: target."],
  accessibility: ["Groups expose aria-expanded; output is text, never raw terminal control sequences."],
  tokens: ["--line", "--icon-size-md", "--motion-base"],
};
