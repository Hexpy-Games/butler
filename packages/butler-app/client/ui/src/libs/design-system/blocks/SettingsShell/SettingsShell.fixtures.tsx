import { Button } from "../../components/Button";
import { SettingsNav } from "../SettingsNav";
import { SettingsHeader } from "../SettingsHeader";
import { SettingsShell } from "./SettingsShell";

export function SettingsShellFixture() {
  return (
    <SettingsShell
      sidebar={
        <SettingsNav
          items={[
            { id: "general", label: "General", active: true },
            { id: "models", label: "Models" },
          ]}
        />
      }
      detail={
        <SettingsHeader
          title="General"
          description="Responsive settings shell preview"
          action={<Button size="sm">Save</Button>}
        />
      }
    />
  );
}
