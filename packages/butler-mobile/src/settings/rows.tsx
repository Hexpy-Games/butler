import { useState } from "react";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { Icon, icons, ListRow, Sheet, Switch, Text, TextField } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import type { AppModelSummary, ReasoningEffort } from "./types";
import { effectiveReasoningEffort, reasoningOptionLabel } from "./useModelCatalog";
import { pad2 } from "./format";

export function SelectRow<T extends string>({ title, description, value, options, onSelect, disabled, disabledReason, search }: {
  title: string; description?: string; value: T;
  options: { value: T; label: string; description?: string; meta?: string; disabled?: boolean }[];
  onSelect(value: T): void; disabled?: boolean; disabledReason?: string; search?: { label: string; empty: string };
}) {
  const M = useMobileCopy();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const visible = search ? options.filter(o => o.label.toLowerCase().includes(query.toLowerCase())) : options;
  return <>
    <ListRow title={title} description={disabled && disabledReason ? disabledReason : description} descriptionLines={3}
      meta={options.find(o => o.value === value)?.label} disabled={disabled}
      trailing={<Icon glyph={icons.ChevronRight} size="lg" tone="tertiary" />} onPress={() => { setQuery(""); setOpen(true); }} />
    <Sheet open={open} onClose={() => setOpen(false)} title={title} cancelLabel={M.settings.cancel}>
      {search ? <TextField label={search.label} value={query} onChangeText={setQuery} /> : null}
      {visible.map(o => <ListRow key={o.value} title={o.label} description={o.description} meta={o.meta}
        selected={o.value === value} disabled={o.disabled} onPress={() => { setOpen(false); if (o.value !== value) onSelect(o.value); }} />)}
      {search && visible.length === 0 ? <Text variant="caption">{search.empty}</Text> : null}
    </Sheet>
  </>;
}

export function SwitchRow({ title, description, value, onChange, disabled }: {
  title: string; description?: string; value: boolean; onChange(value: boolean): void; disabled?: boolean;
}) {
  return <ListRow title={title} description={description} descriptionLines={3} trailing={<Switch value={value} label={title} onValueChange={onChange} disabled={disabled} />} />;
}

export function TimeRow({ title, description, value, onChange, disabled }: {
  title: string; description?: string; value: string; onChange(value: string): void; disabled?: boolean;
}) {
  const M = useMobileCopy();
  const locale = useAppLocale();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"hour" | "minute">("hour");
  const [hour, setHour] = useState(0);
  const [h, m] = value.split(":").map(Number);
  const time = new Date(2000, 0, 1, h, m);
  const minutes = [...new Set([...Array.from({ length: 12 }, (_, i) => i * 5), m])].sort((a, b) => a - b);
  return <>
    <ListRow title={title} description={description} descriptionLines={3} disabled={disabled}
      meta={new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(time)}
      onPress={() => { setHour(h); setStep("hour"); setOpen(true); }} />
    <Sheet open={open} onClose={() => setOpen(false)} title={title} cancelLabel={M.settings.cancel}
      description={step === "hour" ? M.settings.pickHour : M.settings.pickMinute}>
      {step === "hour" ? Array.from({ length: 24 }, (_, n) => <ListRow key={n} selected={n === hour}
        title={new Intl.DateTimeFormat(locale, { hour: "numeric" }).format(new Date(2000, 0, 1, n))}
        onPress={() => { setHour(n); setStep("minute"); }} />)
        : minutes.map(n => <ListRow key={n} title={pad2(n)} selected={n === m}
          onPress={() => { setOpen(false); onChange(`${pad2(hour)}:${pad2(n)}`); }} />)}
    </Sheet>
  </>;
}

export function ReasoningRow({ title, model, value, onSelect }: {
  title: string; model: AppModelSummary | undefined; value: ReasoningEffort; onSelect(value: ReasoningEffort): void;
}) {
  const locale = useAppLocale();
  const efforts = model?.reasoning_efforts ?? ["none"];
  return <SelectRow title={title} value={effectiveReasoningEffort(model, value)} onSelect={onSelect}
    options={efforts.map(e => ({ value: e, label: reasoningOptionLabel(model, e, locale) }))}
    disabled={efforts.length <= 1} disabledReason={getAppCopy(locale).settings.descriptions.reasoningFixed} />;
}
