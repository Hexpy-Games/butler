import type { ShowcaseGuidance } from "../../showcase";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { Trash2 } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ICONS } from "../TabStrip/TabStrip.demo";
import { HistoryGroup, HistoryRow } from "./HistoryRow";

// #region recipe: A day of history
function HistoryDay() {
  return (
    <HistoryGroup title="Today - Sunday, October 11, 2026">
      <HistoryRow title="Docs - Getting started" url="https://docs.example.com/guides/getting-started" iconSrc={ICONS.docs} time="8:27 PM"
        onOpen={() => undefined} actions={<ButtonContainer size="icon-sm"><IconButton label="Delete: Docs"><Trash2 size="md" /></IconButton></ButtonContainer>} />
      <HistoryRow title="Inbox (3)" url="https://mail.example.net/inbox" iconSrc={ICONS.mail} time="8:12 PM" onOpen={() => undefined} />
    </HistoryGroup>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One visit on one dense line (favicon, title, muted host, time at the end) grouped by day, with hover actions and a selection mode.",
  whenToUse: ["Browsing history", "A dated log of pages or sites the user can reopen, delete or select"],
  whenNotToUse: [
    { when: "Address suggestions while typing", use: "SuggestionList" },
    { when: "A generic data row with a description", use: "ListRow" },
    { when: "Navigation rows in a sidebar", use: "NavRow" },
  ],
  recipes: [{ name: "A day of history", description: "A HistoryGroup per day; rows open on click and show their actions on hover.", render: () => <HistoryDay /> }],
  doDont: [
    {
      do: { caption: "Title and host on one line, the time right-aligned, actions only on hover.", render: () => <HistoryDay /> },
      dont: { caption: "Two loose lines and always-on check boxes and buttons bury the titles.", render: () => (
        <Stack gap="xs"><Typo.Body>Docs - Getting started</Typo.Body><Typo.Caption tone="secondary">docs.example.com</Typo.Caption></Stack>
      ) },
    },
  ],
  content: [
    "Time: the short local time (8:27 PM / 오후 08:27); the day goes in the HistoryGroup title.",
    "An empty title shows the host; never invent a title.",
  ],
  accessibility: [
    "At rest the row is a button named by its title and host; Enter opens. In selection mode it is a checkbox named by its title with aria-checked.",
    "Actions stay in the tab order; keyboard focus reveals them in place of the time. Touch shows them beside the time.",
    "Each day is a section labelled by its title.",
  ],
  tokens: ["--control-height-lg", "--selection", "--radius-control", "--text-tertiary", "--line-strong", "--primary", "--primary-foreground"],
};
