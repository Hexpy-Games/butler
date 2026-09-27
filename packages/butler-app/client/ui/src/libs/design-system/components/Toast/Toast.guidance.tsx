import { toast } from "sonner";
import type { ShowcaseGuidance } from "../../showcase";
import { Notice } from "../../blocks/Notice";
import { Button } from "../Button";

// #region recipe: Save confirmation
// The app mounts one <Toaster /> (AppToaster); actions only call toast.*.
function SaveWithToast() {
  return <Button text="Save" onClick={() => toast.success("Settings saved")} />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Transient confirmations and errors at the top center that dismiss themselves (sonner, DS-styled).",
  whenToUse: ["Confirm an action that has no visible result on screen", "Report a background failure with an optional retry or undo"],
  whenNotToUse: [
    { when: "An error tied to one place on the page", use: "Notice" },
    { when: "A decision people must make", use: "Dialog" },
  ],
  recipes: [{ name: "Save confirmation", description: "Mount Toaster once at the app root (AppToaster); call toast.* from actions.", render: () => <SaveWithToast /> }],
  doDont: [
    {
      do: { caption: "A short past-tense confirmation.", render: () => <Button variant="outline" text="Archive" onClick={() => toast.message("Conversation archived", { action: { label: "Undo", onClick: () => undefined } })} /> },
      dont: { caption: "Form validation errors belong next to the form, not in a toast.", render: () => <Notice tone="error" message="Server ID is required" /> },
    },
  ],
  content: ["Past tense for results (Settings saved / 설정을 저장했습니다); errors say what failed."],
  accessibility: ["sonner renders an aria-live region; actions are buttons; toasts pause on hover."],
  tokens: ["--popover", "--shadow-card", "--radius-panel", "--motion-base", "--motion-distance-lg"],
};
