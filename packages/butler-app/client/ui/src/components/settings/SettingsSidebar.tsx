import { useEffect, useMemo, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { ArrowLeft, Input, NavRow, SettingsNav, Stack, Typo } from "@/butler-ds";
import type { SettingsSectionId } from "@/app/types.ts";
import { filterSettingsSectionGroups } from "./settingsSections";
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
  const [searchQuery, setSearchQuery] = useState("");
  const filteredGroups = useMemo(
    () => filterSettingsSectionGroups(sectionGroups, searchQuery),
    [searchQuery, sectionGroups],
  );
  const matchingSections = useMemo(
    () => filteredGroups.flatMap((group) => group.sections),
    [filteredGroups],
  );
  const soleMatchingSectionId =
    searchQuery.trim() && matchingSections.length === 1
      ? matchingSections[0]?.id
      : undefined;
  const autoOpenedSearchRef = useRef<string | null>(null);
  const settingsCopy = appCopy.settings;

  useEffect(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase("en-US");
    if (!normalizedQuery || !soleMatchingSectionId) {
      autoOpenedSearchRef.current = null;
      return;
    }

    const searchKey = `${normalizedQuery}:${soleMatchingSectionId}`;
    if (autoOpenedSearchRef.current === searchKey) return;
    autoOpenedSearchRef.current = searchKey;

    if (activeSection !== soleMatchingSectionId) {
      onSectionChange(soleMatchingSectionId);
    }
  }, [activeSection, onSectionChange, searchQuery, soleMatchingSectionId]);

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
      <Stack gap="sm">
        <Typo.Label htmlFor="settings-navigation-search">
          {settingsCopy.searchLabel}
        </Typo.Label>
        <Input
          id="settings-navigation-search"
          type="search"
          aria-label={settingsCopy.searchLabel}
          placeholder={settingsCopy.searchPlaceholder}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
          data-test-class="settings-navigation-search"
        />
      </Stack>
      {searchQuery.trim() && filteredGroups.length === 0 ? (
        <Typo.Caption
          role="status"
          aria-live="polite"
          data-test-class="settings-search-empty"
        >
          {settingsCopy.searchEmpty(searchQuery.trim())}
        </Typo.Caption>
      ) : null}
      <Stack gap="lg">
        {filteredGroups.map((group) => (
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
