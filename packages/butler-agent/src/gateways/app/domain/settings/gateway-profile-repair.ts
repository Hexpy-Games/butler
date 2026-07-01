import type { SettingsView } from "../../interface/protocol/app-protocol.ts";
import type { AppSettingsPersistence } from "./settings-persistence.ts";

export function repairGatewayProfileState(input: {
  stored: Partial<SettingsView>;
  persistence: AppSettingsPersistence;
  appendEvent: (type: string, payload: Record<string, unknown>) => void;
}): Partial<SettingsView> {
  const rawProfile = (input.stored as Record<string, unknown>).gateway_profile;
  if (rawProfile === "electron") return input.stored;
  const repaired = {
    ...input.stored,
    gateway_profile: "electron" as const,
  };
  input.persistence.write("settings", repaired);
  input.appendEvent("settings.gateway_profile_repaired", {
    gateway_profile: "electron",
    previous_profile_kind: typeof rawProfile,
    had_previous_profile: rawProfile !== undefined,
    raw_text_included: false,
  });
  return repaired;
}
