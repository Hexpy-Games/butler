import { Input } from "../../components/Input";
import { SettingsField } from "./SettingsField";

export function SettingsFieldFixture() {
  return (
    <SettingsField
      id="setting-name"
      label="Display name"
      description="Shown in Butler messages"
      control={<Input id="setting-name" defaultValue="Example User" />}
      meta="Saved locally"
    />
  );
}
