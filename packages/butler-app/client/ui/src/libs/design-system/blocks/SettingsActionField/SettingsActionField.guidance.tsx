import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { MetaList } from "../../components/MetaList";
import { FormSection } from "../FormSection";
import { SurfacePanel } from "../SurfacePanel";
import { SettingsActionField } from "./SettingsActionField";

// #region recipe: Destructive action row
function ResetChatMemory() {
  return (
    <FormSection title="Chat memory">
      <SettingsActionField id="reset-chat" label="Reset chat memory"
        description="Erases everything remembered from chats. This can't be undone."
        action={<Button id="reset-chat" variant="outline" size="sm">Reset</Button>} />
    </FormSection>
  );
}
// #endregion

// #region recipe: Action with the facts it works on
function FreeUpSpace() {
  return (
    <FormSection title="Chat memory">
      <SettingsActionField id="free-space" label="Storage" description="Deletes unused old copies. Memories stay."
        details={<SurfacePanel elevation="subtle">
          <MetaList items={[{ label: "Size", value: "1.2 GB" }, { label: "Can free", value: "312.0 MB" }]} />
        </SurfacePanel>}
        action={<Button id="free-space" variant="outline" size="sm">Free up space</Button>} />
    </FormSection>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A setting that is an action: label, one line on what it does and costs, and the button under them.",
  whenToUse: ["Free up space, reset, clear data, export, run setup again", "Any button that acts on a settings subject"],
  whenNotToUse: [
    { when: "A value the user sets (switch, select, input)", use: "SettingsField" },
    { when: "Add, refresh or filter for a list section", use: "SettingsSection" },
  ],
  recipes: [
    { name: "Destructive action row", description: "The description states the consequence; the caller keeps the confirm dialog.", render: () => <ResetChatMemory /> },
    {
      name: "Action with the facts it works on",
      description: "details holds a subtle SurfacePanel of facts between the description and the button, at the control gap.",
      render: () => <FreeUpSpace />,
    },
  ],
  doDont: [
    {
      do: { caption: "Label, consequence, then the button: the cost is read before the click.", render: () => <ResetChatMemory /> },
      dont: {
        caption: "A button beside the section title says nothing about what it removes.",
        render: () => (
          <FormSection title="Chat memory" actions={<Button variant="outline" size="sm">Reset</Button>}>
            <SettingsActionField id="reset-dont" label="Storage" description="Deletes old memory files Butler no longer uses."
              action={<Button id="reset-dont" variant="outline" size="sm">Free up space</Button>} />
          </FormSection>
        ),
      },
    },
  ],
  content: [
    "The label names the subject (\"Reset chat memory\"); the button is the verb (\"Reset\").",
    "One short description line; destructive actions end with \"This can't be undone.\"",
    "details shows only facts about what the action changes (size, count, what can be freed); no second description.",
  ],
  accessibility: [
    "A bare Button action gets the description id in aria-describedby, with or without details; a Tooltip-wrapped one sets it from descriptionId.",
    "Disabled actions keep a tooltip with the reason; progress under the button uses role=status.",
  ],
  tokens: ["--settings-field-copy-gap", "--settings-field-control-gap", "--settings-field-gap"],
};
