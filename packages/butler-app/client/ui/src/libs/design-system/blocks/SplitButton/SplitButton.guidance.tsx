import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { SplitButton } from "./SplitButton";

// #region recipe: Approval with a scope choice
function Approval() {
  return (
    <ButtonContainer size="sm" justify="end">
      <Button size="sm" variant="outline" text="Deny" />
      <SplitButton size="sm" text="Allow once" menuLabel="More allow options" onClick={() => undefined}
        items={[{ key: "conversation", label: "Allow for this conversation", onSelect: () => undefined }]} />
    </ButtonContainer>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A primary action joined to a menu of related variants of the same action.",
  whenToUse: ["An approval with scope options (Allow once / for this conversation)", "Run now with scheduled alternatives"],
  whenNotToUse: [
    { when: "Unrelated actions", use: "DropdownMenu" },
    { when: "One action", use: "Button" },
  ],
  recipes: [{ name: "Approval with a scope choice", description: "The main half runs the common case; the arrow opens the variants.", render: () => <Approval /> }],
  doDont: [
    {
      do: { caption: "The menu holds variants of the primary action.", render: () => <Approval /> },
      dont: {
        caption: "Two separate primary buttons for one decision.",
        render: () => <ButtonContainer size="sm"><Button size="sm" text="Allow once" /><Button size="sm" text="Allow for this conversation" /></ButtonContainer>,
      },
    },
  ],
  content: ["Main label is the default choice; menu items say how they differ."],
  accessibility: ["Two buttons in one labelled group; menuLabel names the arrow; the arrow disables when no item can run."],
  tokens: ["--control-height-sm", "--radius-control", "--menu-item-height"],
};
