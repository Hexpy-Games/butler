import type { ShowcaseGuidance } from "../../showcase";
import { ComposerControl } from "../../blocks/ComposerControl";
import { SettingsField, SettingsFieldScopeProvider } from "../../blocks/SettingsField";
import { Stack } from "../Stack";
import { Switch } from "../Switch";
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

// #region recipe: Reason beside a settings control
function ReasonBesideControl() {
  return (
    <SettingsFieldScopeProvider>
      <SettingsField id="sandbox" label="Command sandbox" description="Runs commands that change files in an isolated environment."
        control={<Switch id="sandbox" checked={false} disabledReason="Not available on this device" />} />
    </SettingsFieldScopeProvider>
  );
}
// #endregion

function CoveredLabel() {
  return (
    <SettingsFieldScopeProvider>
      <SettingsField id="sandbox-covered" label="Command sandbox" description="Runs commands that change files in an isolated environment."
        control={<Tooltip label="Not available on this device" side="top" open><Switch id="sandbox-covered" checked={false} disabled /></Tooltip>} />
    </SettingsFieldScopeProvider>
  );
}

export const guidance: ShowcaseGuidance = {
  purpose: "A short glass label shown after a hover delay or on keyboard focus.",
  whenToUse: ["Name an icon-only control (IconButton does it for you)", "Explain why a control is unavailable"],
  whenNotToUse: [
    { when: "Content people must read or act on", use: "Popover" },
    { when: "Inline help under a field", use: "FieldDescription" },
    { when: "An icon-only button", use: "IconButton" },
  ],
  recipes: [
    { name: "Explain an unavailable control", description: "Wrap the control; mirror the hint in its aria-label.", render: () => <UnavailableModel /> },
    {
      name: "Reason beside a settings control",
      description: "Switch disabledReason opens to the right by default (disabledReasonSide), clear of the label and description stacked above it.",
      render: () => <ReasonBesideControl />,
    },
  ],
  doDont: [
    {
      do: { caption: "One short line that names or explains.", render: () => <UnavailableModel /> },
      dont: { caption: "Paragraphs in a tooltip vanish before they are read.", render: () => <Stack gap="xs"><Typo.Caption>Tooltips with long instructions, links or several sentences</Typo.Caption></Stack> },
    },
    {
      do: { caption: "Open the reason beside the control (side right).", render: () => <ReasonBesideControl /> },
      dont: { caption: "Opening it above a stacked field covers the label and description.", render: () => <CoveredLabel /> },
    },
  ],
  content: [
    "Sentence fragments, no trailing period; under about 60 characters.",
    "wrap lets a longer label (e.g. the first line of an error log) wrap within the tooltip's width instead of one clipped line.",
    "side (top, right, bottom, left; default top) and align (start, center, end; default center) place it. Pick the side that covers nothing the reader needs: names of icon buttons go top; a disabled reason on a control under or after its label goes right.",
    "Without room on its side it flips to the opposite side, then the cross sides, and shifts to stay inside the viewport and below the titlebar.",
  ],
  accessibility: [
    "Opens on focus-visible without delay; linked with aria-describedby while open; never holds focusable content.",
    "Touch screens do not open tooltips on tap today, so a tooltip never carries the only copy of something people need on a phone.",
  ],
  tokens: ["--tinted-glass-bg", "--radius-control", "--motion-enter-menu", "--motion-distance-sm", "--motion-exit-fast", "--z-tooltip"],
};
