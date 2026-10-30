import { useId, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { DisclosureRow, NativeSelect, SettingsField, Stack } from "@/butler-ds";
import { LOG_SEVERITIES } from "./logsApi";

const INHERIT = "";

/** 분류별 수준: one collapsed row; open, one level select per known category. */
export function LogCategoryLevels({ overrides, categories, disabled, onChange }: {
  overrides: Record<string, string>;
  categories: readonly string[];
  disabled: boolean;
  onChange: (category: string, level: string | null) => void;
}) {
  const copy = appCopy.settings.logs;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const names = [...new Set([...Object.keys(overrides), ...categories])].sort();
  const changed = Object.keys(overrides).length;
  return (
    <DisclosureRow
      surface="plain"
      title={copy.categories}
      meta={changed > 0 ? copy.categoriesChanged(changed) : undefined}
      controlsId={panelId}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      data-test-class="logs-category-levels"
    >
      {names.length > 0 ? (
        <Stack gap="sm" id={panelId}>
          {names.map((name) => (
            <CategoryLevel key={name} name={name} value={overrides[name] ?? INHERIT} disabled={disabled} onChange={onChange} />
          ))}
        </Stack>
      ) : null}
    </DisclosureRow>
  );
}

function CategoryLevel({ name, value, disabled, onChange }: {
  name: string;
  value: string;
  disabled: boolean;
  onChange: (category: string, level: string | null) => void;
}) {
  const copy = appCopy.settings.logs;
  const id = useId();
  return (
    <SettingsField
      id={id}
      label={name}
      control={
        <NativeSelect id={id} size="sm" value={value} disabled={disabled}
          onChange={(event) => onChange(name, event.currentTarget.value || null)}>
          <option value={INHERIT}>{copy.categoryInherit}</option>
          {LOG_SEVERITIES.map((level) => <option key={level} value={level}>{copy.severity[level]}</option>)}
        </NativeSelect>
      }
    />
  );
}
