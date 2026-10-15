import type { ShowcaseGuidance } from "../../showcase";
import { ButtonContainer } from "../ButtonContainer";
import { CopyButton } from "../CopyButton";
import { IconButton } from "../IconButton";
import { Library } from "../Icons";
import { DoneIconButton } from "./DoneIconButton";

const save = () => new Promise<void>((resolve) => setTimeout(resolve, 300));

// #region recipe: Save beside copy
function SaveAndCopy() {
  return (
    <ButtonContainer size="icon-sm">
      <DoneIconButton icon={<Library size="sm" />} label="Save to library" doneLabel="Saved to library" onAction={save} />
      <CopyButton label="Copy" copiedLabel="Copied" text="Lakeside loop trail" />
    </ButtonContainer>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "An icon-only action that confirms success with the same icon-to-check morph as CopyButton, once its promise resolves.",
  whenToUse: ["Save an item to the library (서랍) from a card, a gallery or the image viewer",
    "Any one-shot icon action whose success the user should see on the button itself"],
  whenNotToUse: [
    { when: "Copying text", use: "CopyButton" },
    { when: "An action that opens, toggles or navigates", use: "IconButton" },
  ],
  recipes: [{ name: "Save beside copy", description: "Save and copy confirm with one shared morph.", render: () => <SaveAndCopy /> }],
  doDont: [
    {
      do: { caption: "The save confirms on the button once it has succeeded.", render: () => <SaveAndCopy /> },
      dont: { caption: "An IconButton that saves gives no feedback where the user looked.",
        render: () => <IconButton label="Save to library"><Library size="sm" /></IconButton> },
    },
  ],
  content: ["label names the action (Save to library / 서랍에 저장); doneLabel states the result (Saved to library / 서랍에 저장했어요)."],
  accessibility: [
    "The tooltip and accessible name switch to doneLabel while the check shows; the icon swap is decorative.",
    "doneLabel is announced in a polite live region; pass announce={false} when the action already announces its result (a toast), so it is said once.",
    "A rejected action shows no check; clicks while it runs are ignored.",
  ],
  tokens: ["--motion-fast", "--motion-scale-menu", "--color-success"],
};
