import { SettingsHeader } from "@/butler-ds";
import type { ReactNode } from "react";

interface SettingsDetailHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  secondary?: ReactNode;
}

/** The settings page header: title and description only (subpages add their breadcrumb as `secondary`). */
export function SettingsDetailHeader({
  title,
  description,
  secondary,
}: SettingsDetailHeaderProps) {
  return (
    <div
      className="settings-header settings-detail-header"
      data-test-class="settings-header settings-detail-header"
    >
      <SettingsHeader
        title={<span data-test-class="settings-detail-title">{title}</span>}
        description={description}
        secondary={secondary}
      />
    </div>
  );
}
