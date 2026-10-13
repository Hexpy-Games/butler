import type { ShowcaseGuidance } from "../../showcase";
import { Server } from "../../components/Icons";
import { ProviderLogo } from "../../components/ProviderLogo";
import { Switch } from "../../components/Switch";
import { ChoiceCard, ChoiceCardList } from "../ChoiceCard";
import { CheckCard, CheckCardList } from "./CheckCard";

// #region recipe: Pick the tools to import from
function PickTools() {
  return (
    <CheckCardList label="What should Butler import?">
      <CheckCard icon={<ProviderLogo name="claude" />} title="Claude Code" description="Instructions · 3 MCP servers" checked onCheckedChange={() => undefined} />
      <CheckCard icon={<ProviderLogo name="openai" />} title="Codex" description="2 MCP servers" checked={false} onCheckedChange={() => undefined} />
    </CheckCardList>
  );
}
// #endregion

// #region recipe: An item that cannot be picked
function Blocked() {
  return (
    <CheckCardList label="What to import from Codex">
      <CheckCard icon={<Server size="md" />} title="sentry" description="MCP server · Needs a key" checked onCheckedChange={() => undefined} />
      <CheckCard icon={<Server size="md" />} title="AGENTS.md" description="Empty file" checked={false} disabledReason="Empty file" onCheckedChange={() => undefined} />
    </CheckCardList>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Choose several items to act on (import, include, bring over): a card per item with a round check indicator.",
  whenToUse: ["Picking several tools, files, servers or items before one action runs on them", "A short list where each item benefits from a logo, a name and a one-line detail"],
  whenNotToUse: [
    { when: "Picking exactly one option", use: "ChoiceCard" },
    { when: "A setting that is on or off and takes effect at once", use: "Switch" },
    { when: "A long, dense list of rows", use: "ListRow" },
  ],
  recipes: [
    { name: "Pick the tools to import from", description: "Items that hold something start checked; the action button says what happens next.", render: () => <PickTools /> },
    { name: "An item that cannot be picked", description: "disabledReason dims the card, keeps it focusable and explains why in a tooltip.", render: () => <Blocked /> },
  ],
  doDont: [
    {
      do: { caption: "Choose several items with check cards.", render: () => <PickTools /> },
      dont: { caption: "A switch is an on/off setting, not a selection.", render: () => <Switch aria-label="Codex" defaultChecked /> },
    },
    {
      do: { caption: "One choice among several: ChoiceCard radio rows.", render: () => (
        <ChoiceCardList role="radiogroup" aria-label="Model">
          <ChoiceCard role="radio" aria-checked selected chevron={false} icon={<ProviderLogo name="ollama" />} title="qwen3:8b" meta="5.2 GB" />
        </ChoiceCardList>
      ) },
      dont: { caption: "Do not use check cards for a single choice.", render: () => <CheckCard title="qwen3:8b" checked onCheckedChange={() => undefined} /> },
    },
  ],
  content: [
    "Title: the item's own name (Codex, linear, Bookmarks). Description: what it holds or what it needs, in a few words (MCP server · Needs a key).",
    "Start items checked when they are what people usually want; let the action button carry the verb (Import, Next).",
  ],
  accessibility: [
    "Each card is a button with role=checkbox and aria-checked; click or Space toggles it. The description is its aria-describedby.",
    "CheckCardList is a ul with role=group; pass label, or aria-labelledby pointing at the step title or a legend.",
    "disabledReason keeps the card focusable (aria-disabled) so keyboard and pointer users can read the tooltip.",
    "Motion: checking fills the ring from the centre and draws the check; unchecking reverses, quicker. Press scales on --motion-scale-press. Reduced motion keeps only fades.",
  ],
  tokens: ["--control-bg", "--control-hover-bg", "--line", "--line-strong", "--accent", "--color-info-bg", "--primary-foreground", "--radius-panel", "--radius-pill", "--focus-ring",
    "--icon-size-lg", "--border-width-strong", "--motion-base", "--motion-fast", "--motion-instant", "--motion-exit-base", "--motion-exit-fast", "--motion-ease-standard",
    "--motion-ease-decelerate", "--motion-ease-accelerate", "--motion-ease-draw", "--motion-scale-check", "--motion-scale-press"],
};
