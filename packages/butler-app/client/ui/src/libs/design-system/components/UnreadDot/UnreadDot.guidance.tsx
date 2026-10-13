import type { ShowcaseGuidance } from "../../showcase";
import { CircleAlert, MessageSquare } from "../Icons";
import { IconSlot } from "../IconSlot";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { UnreadDot } from "./UnreadDot";

// #region recipe: Unread conversation row
function UnreadRow() {
  return (
    <Stack align="row" cross="center" gap="sm">
      <IconSlot size="sidebar"><MessageSquare /></IconSlot>
      <Typo.Text grow truncate>Weekly plan review</Typo.Text>
      <UnreadDot label="Unread" />
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A quiet accent dot for content the user has not seen yet, in the row's trailing status column.",
  whenToUse: [
    "A conversation or item with a new reply the user has not opened",
    "A collapsed folder that holds an unread row",
  ],
  whenNotToUse: [
    { when: "Something that needs the user's action", use: "IconSlot" },
    { when: "Work in progress", use: "Spinner" },
    { when: "A number of new items", use: "Tag" },
  ],
  recipes: [{ name: "Unread conversation row", description: "The dot takes the trailing slot when the row has no attention or working mark.", render: () => <UnreadRow /> }],
  doDont: [
    {
      do: { caption: "One trailing mark: the dot in the status column.", render: () => <UnreadRow /> },
      dont: {
        caption: "Do not stack the dot with another status mark.",
        render: () => (
          <Stack align="row" cross="center" gap="sm">
            <Typo.Text grow truncate>Weekly plan review</Typo.Text>
            <UnreadDot label="Unread" />
            <IconSlot size="sidebar"><CircleAlert /></IconSlot>
          </Stack>
        ),
      },
    },
  ],
  content: ["Label it Unread (읽지 않음)."],
  accessibility: [
    "role=\"img\" with the label. Inside a row with its own name, also pass the label as the row's ariaDescription.",
    "Never pulses. Enter and exit are short transitions; reduced motion shows and hides it at once. Forced colors draw it in the text color.",
  ],
  tokens: ["--accent", "--radius-pill", "--sidebar-icon-size", "--motion-base", "--motion-exit-base", "--motion-ease-decelerate", "--motion-ease-accelerate"],
};
