import { useAppLocale } from "@/app/copy.ts";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import {
  ArrowLeft, Input, NavRow, ScrollArea, Separator, SettingsNav, Stack, Typo,
} from "@/butler-ds";
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
  useAppLocale();
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
    <Stack fill gap="md" data-active={isActive ? "true" : undefined}>
      <Stack
        as="header"
        align="row"
        cross="center"
        windowDrag="drag"
        data-test-class="settings-header settings-titlebar"
      >
        <NavRow
          ariaLabel={backLabel}
          windowDrag="no-drag"
          icon={<ArrowLeft size="lg" />}
          label={backLabel}
          onClick={onClose}
        />
      </Stack>
      <Stack role="search" gap="none">
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
      <ScrollArea
        fill
        windowDrag="no-drag"
        dataTestClass="settings-navigation-scroll"
      >
        <Stack gap="lg">
          {filteredGroups.map((group, index) => (
            <Fragment key={group.id}>
              {/* A hairline sets the Advanced group apart from everyday settings. */}
              {group.id === "advanced" && index > 0 && <Separator space="none" tone="muted" />}
              <SettingsNav
                title={group.label}
                items={group.sections.map((item) => ({
                  id: item.id,
                  label: item.label,
                  icon: item.icon,
                  active: activeSection === item.id,
                  onSelect: () => onSectionChange(item.id),
                }))}
              />
            </Fragment>
          ))}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}
