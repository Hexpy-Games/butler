import { FormRow } from "./FormRow";
import { Input } from "../../components/Input";
import { Switch } from "../../components/Switch";
import { Stack } from "../../components/Stack";

export function FormRowFixture() {
  return (
    <Stack gap="2">
      <FormRow
        label="Project name"
        help="Choose a unique name for your project"
      >
        <Input placeholder="My Project" />
      </FormRow>

      <FormRow
        label="Enable notifications"
        help="Receive alerts for important events"
      >
        <Switch />
      </FormRow>

      <FormRow
        label="API Key"
        error="Invalid API key format"
      >
        <Input placeholder="sk-..." />
      </FormRow>
    </Stack>
  );
}
