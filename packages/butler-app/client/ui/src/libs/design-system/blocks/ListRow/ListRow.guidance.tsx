import type { ShowcaseGuidance } from "../../showcase";
import { Clickable } from "../../components/Clickable";
import { Clock3 } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ListRow } from "./ListRow";

// #region recipe: Clickable automation row
function AutomationItem() {
  return (
    <Clickable onClick={() => undefined} stretch>
      <ListRow icon={<Clock3 size="md" />} title="Nightly release notes" description="butler · main" meta="Every day 07:00" />
    </Clickable>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A presentational row: icon, title, optional description and trailing meta. The title truncates; a meta that does not fit beside it moves under the title.",
  whenToUse: ["Rows of data in panels and lists (automations, artifacts, models)"],
  whenNotToUse: [
    { when: "Navigation rows", use: "NavRow" },
    { when: "Label/value facts", use: "KeyValueRow" },
    { when: "A document with open/save actions", use: "DocumentTile" },
  ],
  recipes: [{ name: "Clickable automation row", description: "ListRow has no behavior; wrap it in Clickable to make it selectable.", render: () => <AutomationItem /> }],
  doDont: [
    {
      do: { caption: "Meta stays right-aligned while it fits; the title truncates first and keeps at least half the line.", render: () => <AutomationItem /> },
      dont: {
        caption: "A hand-built row misaligns icon and title and never truncates.",
        render: () => <Stack align="row" gap="sm"><Clock3 size="md" /><Typo.Body>Nightly release notes</Typo.Body><Typo.Caption>Every day 07:00</Typo.Caption></Stack>,
      },
    },
  ],
  content: [
    "Titles are names; meta is a short fact (size, time, schedule).",
    "A meta longer than half the row's line, or any meta in a narrow row, moves under the title and wraps; never shorten it to keep one line.",
  ],
  accessibility: ["Pure presentation; the wrapping Clickable or button provides the role and name."],
  tokens: ["--space-sm", "--text-secondary", "--icon-size-md"],
};
