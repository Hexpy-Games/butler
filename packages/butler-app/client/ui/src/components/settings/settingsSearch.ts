import type { SettingsCopy, SettingsSectionDescriptor, SettingsSectionGroupDescriptor } from "./settingsTypes";

/** A moved setting's labels belong to its current page, including older search aliases. */
export function settingsSearchAliases(copy: SettingsCopy, id: SettingsSectionDescriptor["id"]): string[] {
  const assigned: Partial<Record<SettingsSectionDescriptor["id"], string[]>> = {
    memory: [copy.pageSections.noticedPatterns, copy.memory.proactiveLevel, copy.memory.quietHours, copy.pageSections.memoryCleanup, copy.fields.consolidationTime, copy.fields.consolidationModel],
  };
  const inherited = copy.sectionAliases[id].filter((alias) => !Object.entries(assigned).some(([owner, labels]) =>
    owner !== id && labels.some((label) => normalizeSettingsSearchValue(label) === normalizeSettingsSearchValue(alias))));
  return [...inherited, ...(assigned[id] ?? [])];
}

function normalizeSettingsSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function matchesSettingsSearchValue(value: string, query: string): boolean {
  return normalizeSettingsSearchValue(value).includes(query);
}

export function matchesSettingsSection(
  section: SettingsSectionDescriptor,
  query: string,
  fallback: string[] = [],
): boolean {
  const normalizedQuery = normalizeSettingsSearchValue(query);
  return [section.label, section.description, ...section.aliases, ...fallback]
    .some((value) => matchesSettingsSearchValue(value, normalizedQuery));
}

export function filterSettingsSectionGroups(
  groups: SettingsSectionGroupDescriptor[],
  query: string,
): SettingsSectionGroupDescriptor[] {
  const normalizedQuery = normalizeSettingsSearchValue(query);
  if (!normalizedQuery) return groups;

  return groups
    .map((group) => {
      if (matchesSettingsSearchValue(group.label, normalizedQuery)) return group;

      return {
        ...group,
        sections: group.sections.filter((section) =>
          matchesSettingsSection(section, normalizedQuery),
        ),
      };
    })
    .filter((group) => group.sections.length > 0);
}
