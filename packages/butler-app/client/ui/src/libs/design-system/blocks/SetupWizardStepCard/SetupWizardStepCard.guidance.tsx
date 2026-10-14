import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { ShieldCheck } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { SetupWizardShell } from "../SetupWizardShell";
import { SetupWizardStepAction, SetupWizardStepCard } from "./index";

const STEPS = [{ id: "welcome", label: "Welcome" }, { id: "consent", label: "Consent" }, { id: "connect", label: "Connect AI" }, { id: "finish", label: "Finish" }];

// #region recipe: Consent step
function ConsentStep() {
  return (
    <SetupWizardShell anchor="top" embedded stepKey="steps" title="Butler" variant="focus">
      <SetupWizardStepCard activeIndex={1} backLabel="Back" onBack={() => undefined}
        progressLabel="Setup steps" steps={STEPS} title="Before you start" titleId="setup-step-title"
        actions={<><SetupWizardStepAction text="Decline" /><SetupWizardStepAction forward text="Agree and continue" /></>}>
        <Typo.Body>Butler can create, change and delete files and run commands on this computer.</Typo.Body>
      </SetupWizardStepCard>
    </SetupWizardShell>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One step of a focus-variant setup flow: header (back · steps), a title on the content's left edge, the step's content and a footer with right-aligned large actions.",
  whenToUse: ["Every step after the intro in a first-run or setup flow", "A sub-step (sign-in, API key, model pick) that keeps the flow's header and footer"],
  whenNotToUse: [
    { when: "The intro or welcome screen of a flow", use: "SetupWizardContent" },
    { when: "A short task inside the app", use: "DialogForm" },
    { when: "A settings page", use: "SettingsShell" },
  ],
  recipes: [
    { name: "Consent step", description: "Inside SetupWizardShell variant=\"focus\" anchor=\"top\"; Decline then the forward action last.", render: () => <ConsentStep /> },
  ],
  doDont: [
    {
      do: { caption: "The forward action is content-width, right-aligned and ends with ›.", render: () => <SetupWizardStepAction forward text="Continue" /> },
      dont: { caption: "A full-width black bar outweighs the card's content.", render: () => <Button size="lg" stretch text="Continue" /> },
    },
    {
      do: { caption: "The title starts on the same left edge as the content.", render: () => <Stack gap="xs"><Typo.H4 as="span">Before you start</Typo.H4><Typo.Body tone="secondary">Butler runs on this computer.</Typo.Body></Stack> },
      dont: { caption: "A glyph before the title indents it off the content edge.", render: () => <Stack align="row" gap="sm" cross="start"><ShieldCheck size="lg" /><Stack gap="xs"><Typo.H4 as="span">Before you start</Typo.H4><Typo.Body tone="secondary">Butler runs on this computer.</Typo.Body></Stack></Stack> },
    },
  ],
  content: [
    "Titles say what the step is about or what happened (Sign in to ChatGPT / Connected to ChatGPT); derive them from state.",
    "The description is one line. Status goes in footerStart, not in a banner.",
    "Only forward actions get ›: Next, Connect, Agree and continue. Cancel, Decline and Try again do not.",
  ],
  accessibility: [
    "The title is focusable (tabIndex -1): move focus to titleId when the step changes.",
    "The step indicator is an ordered list with aria-current=\"step\" and a progressLabel.",
  ],
  tokens: ["--typo-h4-size", "--typo-h4-line-height", "--control-height-lg", "--space-lg", "--motion-base", "--motion-ease-decelerate"],
};
