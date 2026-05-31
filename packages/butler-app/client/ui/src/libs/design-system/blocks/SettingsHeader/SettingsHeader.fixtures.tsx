import { Button } from "../../components/Button";
import { SettingsHeader } from "./SettingsHeader";

export function SettingsHeaderFixture() {
  return (
    <SettingsHeader
      title="Appearance"
      description="Choose a theme and density that fits your workspace."
      action={<Button size="sm" variant="outline">Reset</Button>}
    />
  );
}
