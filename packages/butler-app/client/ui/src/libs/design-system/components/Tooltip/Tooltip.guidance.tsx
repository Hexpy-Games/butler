import type { ShowcaseGuidance } from "../../showcase";
import { ComposerControl } from "../../blocks/ComposerControl";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { AiChip } from "../Icons";
import { Tooltip } from "./Tooltip";

// #region recipe: Explain an unavailable control
function UnavailableModel() {
  return (
    <Tooltip label="Switch models after this response finishes">
      <ComposerControl aria-disabled="true" aria-label="Model. Switch models after this response finishes" icon={<AiChip size="sm" />} label="Model" />
    </Tooltip>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A short glass label shown after a hover delay or on keyboard focus.",
  whenToUse: ["Name an icon-only control (IconButton does it for you)", "Explain why a control is unavailable"],
  whenNotToUse: [
    { when: "Content people must read or act on", use: "Popover" },
    { when: "Inline help under a field", use: "FieldDescription" },
    { when: "An icon-only button", use: "IconButton" },
  ],
  recipes: [{ name: "Explain an unavailable control", description: "Wrap the control; mirror the hint in its aria-label.", render: () => <UnavailableModel /> }],
  doDont: [
    {
      do: { caption: "One short line that names or explains.", render: () => <UnavailableModel /> },
      dont: { caption: "Paragraphs in a tooltip vanish before they are read.", render: () => <Stack gap="xs"><Typo.Caption>Tooltips with long instructions, links or several sentences</Typo.Caption></Stack> },
    },
  ],
  content: ["Sentence fragments, no trailing period; under about 60 characters."],
  accessibility: ["Opens on focus-visible without delay; linked with aria-describedby while open; never holds focusable content."],
  tokens: ["--tinted-glass-bg", "--radius-control", "--motion-fast", "--z-tooltip"],
};
