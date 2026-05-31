import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Input } from "../../components/Input";
import { SettingsField } from "../SettingsField";
import { DialogForm } from "./DialogForm";

export function DialogFormFixture() {
  return (
    <DialogForm
      title="Rename session"
      description="Use a clear name for the current task."
      footer={
        <ButtonContainer size="default" justify="end">
          <Button variant="outline">Cancel</Button>
          <Button>Save</Button>
        </ButtonContainer>
      }
    >
      <SettingsField
        id="rename"
        label="Name"
        control={<Input id="rename" defaultValue="Design work" />}
      />
    </DialogForm>
  );
}
