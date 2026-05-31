import { useMemo, useState } from "react";
import {
  Button,
  ChevronsUpDown,
  FilteredSelectPopover,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SettingsField,
} from "@/butler-ds";

export interface SettingsSearchableSelectOption {
  value: string;
  label: string;
  description?: string;
}

export function SettingsSearchableSelect({
  label,
  description,
  value,
  options,
  searchLabel,
  searchPlaceholder,
  searchClearLabel,
  allLabel,
  emptyLabel,
  onChange,
}: {
  label: string;
  description?: string;
  value: string;
  options: SettingsSearchableSelectOption[];
  searchLabel: string;
  searchPlaceholder: string;
  searchClearLabel: string;
  allLabel: string;
  emptyLabel: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const selectedOption = options.find((option) => option.value === value);
  const filteredOptions = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    if (!query) return options;
    return options.filter((option) =>
      [option.label, option.value, option.description ?? ""].some((item) =>
        item.toLowerCase().includes(query),
      ),
    );
  }, [options, searchValue]);

  return (
    <SettingsField
      data-test-class="settings-searchable-select-field"
      label={label}
      description={description}
      control={
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              data-test-class="settings-searchable-select-trigger"
              iconEnd={<ChevronsUpDown size={14} />}
              stretch
              text={selectedOption?.label ?? value}
            />
          </PopoverTrigger>
          <PopoverContent
            align="end"
            data-menu-size="fit"
            sideOffset={6}
          >
            <FilteredSelectPopover
              title={label}
              searchLabel={searchLabel}
              searchPlaceholder={searchPlaceholder}
              searchClearLabel={searchClearLabel}
              searchValue={searchValue}
              filters={[{ id: "all", label: allLabel }]}
              activeFilterId="all"
              onFilterChange={() => undefined}
              onSearchChange={setSearchValue}
              emptyLabel={emptyLabel}
              groups={[{
                id: "timezones",
                title: allLabel,
                items: filteredOptions.map((option) => ({
                  id: option.value,
                  label: option.label,
                  description: option.description,
                  selected: option.value === value,
                  onSelect: () => {
                    onChange(option.value);
                    setOpen(false);
                  },
                })),
              }]}
              width="fixed"
              resultsMaxRows={6.5}
            />
          </PopoverContent>
        </Popover>
      }
    />
  );
}
