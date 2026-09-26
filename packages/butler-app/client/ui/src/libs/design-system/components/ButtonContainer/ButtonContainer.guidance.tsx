import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { Stack } from "../Stack";
import { ButtonContainer } from "./ButtonContainer";

// #region recipe: Right-aligned form actions
function FormActions() {
  return (
    <ButtonContainer size="sm" justify="end">
      <Button size="sm" variant="borderless" text="Cancel" />
      <Button size="sm" text="Save" />
    </ButtonContainer>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Lays out two or more adjacent buttons with the gap that matches their size.",
  whenToUse: ["Place several buttons next to each other", "Align a group of actions to the end of a footer"],
  whenNotToUse: [
    { when: "A single button", use: "Button" },
    { when: "Icon actions trailing a list row", use: "RowActionCluster" },
    { when: "General row layout of mixed content", use: "Stack" },
  ],
  recipes: [{ name: "Right-aligned form actions", description: "Pass the same size to the container and every button inside it.", render: () => <FormActions /> }],
  doDont: [
    {
      do: { caption: "The container size matches its buttons, so the gap is right.", render: () => <FormActions /> },
      dont: {
        caption: "A Stack with a guessed gap and mixed sizes.",
        render: () => <Stack align="row" gap="xl"><Button size="xs" variant="borderless" text="Cancel" /><Button text="Save" /></Stack>,
      },
    },
  ],
  content: ["Order: the least destructive action first, the primary action last (end side)."],
  accessibility: ["Buttons keep their own names; the container adds no role."],
  tokens: ["--space-sm", "--space-xs"],
};
