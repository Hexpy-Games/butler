import { FormSection } from "./FormSection";
import { FormRow } from "../FormRow";
import { Input } from "../../components/Input";
import { Switch } from "../../components/Switch";

export function FormSectionFixture() {
  return (
    <FormSection title="API Configuration" description="Configure your API settings">
      <FormRow label="API Key"><Input placeholder="sk-..." /></FormRow>
      <FormRow label="Enable API"><Switch /></FormRow>
      <FormRow label="Rate Limit"><Input type="number" placeholder="100" /></FormRow>
    </FormSection>
  );
}
