import { ArrowLeft } from "@/butler-ds";
import { NavRow, Stack } from "@/butler-ds";
import { SettingsNav } from "@/butler-ds";
import type { SettingsSectionId } from "@/app/types.ts";
import type { SettingsSectionGroupDescriptor } from "./settingsTypes";

interface SettingsSidebarProps {
  sectionGroups: SettingsSectionGroupDescriptor[];
  activeSection: SettingsSectionId;
  backLabel: string;
  onClose: () => void;
  onSectionChange: (section: SettingsSectionId) => void;
  isActive?: boolean;
}

export function SettingsSidebar({
  sectionGroups,
  activeSection,
  backLabel,
  onClose,
  onSectionChange,
  isActive = false,
}: SettingsSidebarProps) {
  return (
    <Stack gap="md" data-active={isActive ? "true" : undefined}>
      <Stack
        as="header"
        align="row"
        cross="center"
        className="settings-header settings-titlebar drag-region"
        data-test-class="settings-header settings-titlebar"
      >
        <NavRow
          ariaLabel={backLabel}
          className="settings-back-button no-drag"
          icon={<ArrowLeft size={18} />}
          label={backLabel}
          onClick={onClose}
        />
      </Stack>
      <Stack gap="lg">
        {sectionGroups.map((group) => (
          <SettingsNav
            key={group.id}
            title={group.label}
            items={group.sections.map((item) => ({
              id: item.id,
              label: item.label,
              icon: item.icon,
              active: activeSection === item.id,
              onSelect: () => onSectionChange(item.id),
            }))}
          />
        ))}
      </Stack>
    </Stack>
  );
}
