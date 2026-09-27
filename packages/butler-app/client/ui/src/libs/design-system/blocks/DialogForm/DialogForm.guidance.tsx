import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Input } from "../../components/Input";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { SettingsField } from "../SettingsField";
import { DialogForm } from "./DialogForm";

// #region recipe: Create project form
function CreateProject() {
  return (
    <DialogForm title="New project" description="Name the project and pick its folder." onSubmit={() => undefined}
      footer={(
        <ButtonContainer size="default" justify="end">
          <Button type="button" variant="outline" text="Cancel" />
          <Button type="submit" text="Create" />
        </ButtonContainer>
      )}>
      <SettingsField id="project-name" label="Project name" control={<Input id="project-name" defaultValue="butler-site" />} />
    </DialogForm>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The body of a dialog task: title, description, fields and a footer, submitted as a form.",
  whenToUse: ["Create, rename or configure something inside a Dialog"],
  whenNotToUse: [
    { when: "A settings page", use: "FormSection" },
    { when: "A one-question confirmation", use: "DialogHeader" },
  ],
  recipes: [{ name: "Create project form", description: "Put it inside DialogContent; Enter submits, the footer holds the actions.", render: () => <CreateProject /> }],
  doDont: [
    {
      do: { caption: "A real form: Enter submits and fields keep the settings ramp.", render: () => <CreateProject /> },
      dont: { caption: "A raw form with a global class skips the DS layout.", render: () => <Stack gap="md"><Typo.H3>New project</Typo.H3><Input aria-label="Project name" /></Stack> },
    },
  ],
  content: ["Title is the task; the submit label repeats its verb (Create)."],
  accessibility: ["Renders a <form>; pair with a DialogTitle (sr-only) when DialogForm shows the visible title."],
  tokens: ["--space-lg", "--settings-field-gap", "--typo-panel-title-size"],
};
