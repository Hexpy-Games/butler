import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { SurfacePanel } from "./SurfacePanel";

// #region recipe: Settings row panel
function ArchiveRow() {
  return (
    <SurfacePanel elevation="none">
      <Stack align="row" cross="center" gap="md" justify="between" wrap>
        <Stack gap="xs">
          <Typo.Body as="div">Release checklist review</Typo.Body>
          <Typo.Caption>Conversation · 3 days ago</Typo.Caption>
        </Stack>
        <Button size="sm" variant="outline" text="Restore" />
      </Stack>
    </SurfacePanel>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A bordered panel surface with an elevation step for settings rows and grouped content.",
  whenToUse: ["A flat bordered row or group inside settings and developer panels"],
  whenNotToUse: [
    { when: "A clickable item in a grid", use: "Card" },
    { when: "A settings section with a header above", use: "FormSection" },
  ],
  recipes: [{ name: "Settings row panel", description: "elevation=\"none\" for rows; higher elevations for floating groups.", render: () => <ArchiveRow /> }],
  doDont: [
    {
      do: { caption: "A flat panel for a row of facts and one action.", render: () => <ArchiveRow /> },
      dont: { caption: "Cards in settings add shadows where the page is flat.", render: () => <Card><Typo.Body>Release checklist review</Typo.Body></Card> },
    },
  ],
  content: ["Title and one caption line; the action verb says what happens."],
  accessibility: ["A div by default; the content provides headings and names."],
  tokens: ["--surface-raised", "--line", "--radius-panel", "--shadow-card"],
};
