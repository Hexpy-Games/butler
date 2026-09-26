import type { ShowcaseGuidance } from "../../showcase";
import { ButtonContainer } from "../ButtonContainer";
import { Plus } from "../Icons";
import { Stack } from "../Stack";
import { Button } from "./Button";

// #region recipe: Dialog footer actions
function DialogFooterActions() {
  return (
    <ButtonContainer size="default" justify="end">
      <Button type="button" variant="outline" text="Cancel" />
      <Button type="submit" text="Save" />
    </ButtonContainer>
  );
}
// #endregion

// #region recipe: Header action with icon
function HeaderAction() {
  return <Button variant="outline" iconStart={<Plus size="md" />} text="New automation" />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Runs one action from a text label; the primary way to commit, cancel or start something.",
  whenToUse: [
    "Commit or cancel a form or dialog",
    "Start an action from a page or section header",
    "Offer a secondary action next to a primary one",
  ],
  whenNotToUse: [
    { when: "The action is an icon without a visible label", use: "IconButton" },
    { when: "A whole row or card should be clickable", use: "Clickable" },
    { when: "A primary action with related alternatives", use: "SplitButton" },
    { when: "A rounded chip in the composer toolbar", use: "PillButton" },
  ],
  recipes: [
    { name: "Dialog footer actions", description: "Two or more buttons always sit in a ButtonContainer of the same size.", render: () => <DialogFooterActions /> },
    { name: "Header action with icon", description: "Outline buttons carry secondary actions in page headers.", render: () => <HeaderAction /> },
  ],
  doDont: [
    {
      do: { caption: "One default (primary) button per group; the rest are outline or borderless.", render: () => <DialogFooterActions /> },
      dont: {
        caption: "Several primary buttons compete for attention.",
        render: () => <Stack align="row" gap="sm"><Button text="Save" /><Button text="Publish" /><Button text="Share" /></Stack>,
      },
    },
  ],
  content: [
    "Label with a verb: Save, Create project, Retry. Two or three words.",
    "Korean labels end in a noun or 하기-less verb (저장, 새 프로젝트); do not add periods.",
  ],
  accessibility: [
    "It renders a real <button>; pass type=\"submit\" only inside forms.",
    "Disabled buttons use the disabled tone and never scale on press.",
    "Focus draws the shared --focus-ring.",
  ],
  tokens: ["--control-height-md", "--radius-control", "--send-bg", "--focus-ring", "--motion-scale-press"],
};
