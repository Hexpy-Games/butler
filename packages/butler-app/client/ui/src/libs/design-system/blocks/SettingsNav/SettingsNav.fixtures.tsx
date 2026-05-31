import { Palette, Settings } from "../../components/Icons";
import { SettingsNav } from "./SettingsNav";

export function SettingsNavFixture() {
  return (
    <SettingsNav
      items={[
        { id: "general", label: "General", icon: <Settings size={15} />, active: true },
        { id: "appearance", label: "Appearance", icon: <Palette size={15} /> },
      ]}
    />
  );
}
