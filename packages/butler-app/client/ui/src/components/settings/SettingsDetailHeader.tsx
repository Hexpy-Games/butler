import { Notice, SettingsHeader } from "@/butler-ds";
import type { ReactNode } from "react";
import type { SettingsLocalMessage } from "./settingsTypes";

interface SettingsDetailHeaderProps {
  title: ReactNode;
  secondary?: ReactNode;
  localMessage: SettingsLocalMessage | null;
}

export function SettingsDetailHeader({
  title,
  secondary,
  localMessage,
}: SettingsDetailHeaderProps) {
  return (
    <div
      className="settings-header settings-detail-header"
      data-test-class="settings-header settings-detail-header"
    >
      <SettingsHeader
        title={<span data-test-class="settings-detail-title">{title}</span>}
        secondary={secondary}
        action={
          localMessage ? (
            <div
              data-test-class={`settings-status ${localMessage.tone === "ok" ? "ok" : "error"}`}
              role="status"
            >
              <Notice
                message={localMessage.label}
                tone={localMessage.tone === "ok" ? "success" : "error"}
              />
            </div>
          ) : undefined
        }
      />
    </div>
  );
}
