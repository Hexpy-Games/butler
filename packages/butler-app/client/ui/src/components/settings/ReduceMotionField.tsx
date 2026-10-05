import { useState } from "react";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { useSettingsUIStore } from "@/stores/settingsUIStore";
import { SettingsSwitch } from "./SettingsSwitch";
import { useSystemReducedMotion } from "./useSystemReducedMotion";

export function ReduceMotionField() {
  const saved = useSettingsUIStore((state) => state.draft?.reduce_motion ?? false);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const system = useSystemReducedMotion();
  const [pending, setPending] = useState<boolean | null>(null);
  const copy = appCopy.settings;
  return (
    <SettingsSwitch settingId="reduce-motion" label={copy.fields.reduceMotion}
      description={copy.descriptions.reduceMotion} checked={system || (pending ?? saved)}
      disabledReason={system ? copy.descriptions.reduceMotionSystem : undefined}
      onChange={(value) => {
        setPending(value);
        requestAnimationFrame(() => {
          setSettings({ ...useButlerStore.getState().settings, reduce_motion: value });
          void update({ reduce_motion: value }, setSettings).finally(() => {
            setPending(null);
            const current = useSettingsUIStore.getState().baseline;
            if (current) setSettings(current);
          });
        });
      }} />
  );
}
