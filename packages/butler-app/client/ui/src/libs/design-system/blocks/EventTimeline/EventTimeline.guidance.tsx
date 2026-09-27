import type { ShowcaseGuidance } from "../../showcase";
import { Box } from "../../components/Box";
import { Button } from "../../components/Button";
import { CheckCircle2, ChevronRight, FileText, MessageSquare } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { NavRow } from "../NavRow";
import { EventTimeline, EventTimelineItem } from "./EventTimeline";

// #region recipe: Project history day
function HistoryDay() {
  return (
    <EventTimeline>
      <EventTimelineItem marker={<CheckCircle2 />}>
        <Stack gap="xs">
          <NavRow label="Design system final cleanup" multiline actions={<ChevronRight />}
            meta={<Typo.Caption tone="secondary">9:15 AM · Completion recorded</Typo.Caption>} onClick={() => undefined} />
          <Box paddingStart="sm">
            <Button variant="borderless" size="xs" onClick={() => undefined}>
              <MessageSquare /><Typo.Text truncate>Final cleanup session</Typo.Text><ChevronRight />
            </Button>
          </Box>
        </Stack>
      </EventTimelineItem>
      <EventTimelineItem marker={<FileText />}>
        <NavRow label="Spec: Butler Dedicated Client Design System" multiline actions={<ChevronRight />}
          meta={<Typo.Caption tone="secondary">8:15 AM · Updated</Typo.Caption>} onClick={() => undefined} />
      </EventTimelineItem>
    </EventTimeline>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Dated events in order, each with a kind marker joined to the next event by a hairline connector.",
  whenToUse: ["Project history: records created, updated, completed or reported, grouped by day"],
  whenNotToUse: [
    { when: "Progress or recent activity in the inspector", use: "ActivityFeed" },
    { when: "Automation run history", use: "AutomationRunList" },
  ],
  recipes: [{ name: "Project history day", description: "A NavRow per event; a linked session sits one step in (Box paddingStart=\"sm\").", render: () => <HistoryDay /> }],
  doDont: [
    {
      do: { caption: "Markers line up and the connector runs between events.", render: () => <HistoryDay /> },
      dont: { caption: "Bare rows lose the event kind and the sequence.", render: () => <Stack gap="md"><NavRow label="Design system final cleanup" onClick={() => undefined} /><NavRow label="Spec: Butler Dedicated Client Design System" onClick={() => undefined} /></Stack> },
    },
  ],
  content: ["Event titles are record titles; the meta line is time · action · linked results."],
  accessibility: ["Markers are decorative; each row's label states the event and the row is the action."],
  tokens: ["--space-2xl", "--space-md", "--border-hairline", "--line", "--text-tertiary"],
};
