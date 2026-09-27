import type { ShowcaseGuidance } from "../../showcase";
import { MessageFooter } from "../../blocks/MessageRow";
import { IconButton } from "../IconButton";
import { Copy } from "../Icons";
import { CopyButton } from "./CopyButton";

// #region recipe: Message footer copy
function FooterCopy() {
  return (
    <MessageFooter>
      <CopyButton text="Section headers now sit above their cards." label="Copy message" copiedLabel="Copied" />
    </MessageFooter>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Copies text to the clipboard and confirms with an icon morph and a live announcement.",
  whenToUse: ["Copy a message, code block or identifier", "Offer a copy action in a footer or code frame header"],
  whenNotToUse: [
    { when: "Any other icon-only action", use: "IconButton" },
    { when: "Copy a design token name in the viewer", use: "Button" },
  ],
  recipes: [{ name: "Message footer copy", description: "Every copy action in the product uses CopyButton, not a custom icon swap.", render: () => <FooterCopy /> }],
  doDont: [
    {
      do: { caption: "CopyButton confirms visually and to screen readers.", render: () => <FooterCopy /> },
      dont: { caption: "An IconButton that copies silently gives no feedback.", render: () => <IconButton label="Copy message"><Copy size="md" /></IconButton> },
    },
  ],
  content: ["label names what is copied (Copy message, Copy code); copiedLabel is short (Copied / 복사됨)."],
  accessibility: ["The result is announced in an aria-live region; the icon swap is decorative."],
  tokens: ["--motion-fast", "--motion-scale-menu", "--color-success"],
};
