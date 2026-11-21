import { useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { Icon, icons, ListGroup, ListRow, Sheet, Switch, Text, TextField, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import type { AppModelSummary, ReasoningEffort } from "./types";
import { effectiveReasoningEffort, reasoningOptionLabel } from "./useModelCatalog";
import { pad2 } from "./format";

/** Picker rows: the chosen row shows an accent check and says "선택됨"; pickers never use the ListRow `selected` fill. */
export function usePicked() {
  const selected = getAppCopy(useAppLocale()).common.selected;
  return (on: boolean, label: (string | undefined)[]) => on
    ? { trailing: <Icon glyph={icons.CheckIcon} tone="accent" />, accessibilityLabel: [...label, selected].filter(Boolean).join(", ") }
    : {};
}

export function SelectRow<T extends string>({ title, value, options, onSelect, disabled, search }: {
  title: string; value: T;
  options: { value: T; label: string; description?: string; meta?: string; disabled?: boolean }[];
  onSelect(value: T): void; disabled?: boolean; search?: { label: string; empty: string };
}) {
  const M = useMobileCopy();
  const t = useTokens();
  const { height } = useWindowDimensions();
  const picked = usePicked();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const visible = search ? options.filter(o => o.label.toLowerCase().includes(query.toLowerCase())) : options;
  return <>
    <ListRow title={title}
      meta={options.find(o => o.value === value)?.label} disabled={disabled}
      onPress={() => { setQuery(""); setOpen(true); }} />
    <Sheet open={open} onClose={() => setOpen(false)} title={title} cancelLabel={M.settings.cancel}>
      <View style={{ gap: t.length("--space-4"), minHeight: search ? height : undefined }}>
        {search ? <TextField label={search.label} value={query} onChangeText={setQuery} /> : null}
        {visible.length ? <ListGroup>
          {visible.map(o => <ListRow key={o.value} title={o.label} description={o.description} meta={o.meta} disabled={o.disabled}
            {...picked(o.value === value, [o.label, o.description, o.meta])}
            onPress={() => { setOpen(false); if (o.value !== value) onSelect(o.value); }} />)}
        </ListGroup> : null}
        {search && !visible.length ? <Text variant="caption">{search.empty}</Text> : null}
      </View>
    </Sheet>
  </>;
}

export function SwitchRow({ title, value, onChange, disabled }: {
  title: string; value: boolean; onChange(value: boolean): void; disabled?: boolean;
}) {
  return <ListRow title={title} trailing={<Switch value={value} label={title} onValueChange={onChange} disabled={disabled} />} />;
}

export function TimeRow({ title, value, onChange, disabled }: {
  title: string; value: string; onChange(value: string): void; disabled?: boolean;
}) {
  const M = useMobileCopy();
  const locale = useAppLocale();
  const picked = usePicked();
  const hourLabel = (n: number) => new Intl.DateTimeFormat(locale, { hour: "numeric" }).format(new Date(2000, 0, 1, n));
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"hour" | "minute">("hour");
  const [hour, setHour] = useState(0);
  const [h, m] = value.split(":").map(Number);
  const time = new Date(2000, 0, 1, h, m);
  const minutes = [...new Set([...Array.from({ length: 12 }, (_, i) => i * 5), m])].sort((a, b) => a - b);
  return <>
    <ListRow title={title} disabled={disabled}
      meta={new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(time)}
      onPress={() => { setHour(h); setStep("hour"); setOpen(true); }} />
    <Sheet open={open} onClose={() => setOpen(false)} title={title} cancelLabel={M.settings.cancel}
      description={step === "hour" ? M.settings.pickHour : M.settings.pickMinute}>
      <ListGroup>
        {step === "hour" ? Array.from({ length: 24 }, (_, n) => <ListRow key={n} title={hourLabel(n)} navigates
          {...picked(n === hour, [hourLabel(n)])} onPress={() => { setHour(n); setStep("minute"); }} />)
          : minutes.map(n => <ListRow key={n} title={pad2(n)} {...picked(n === m, [pad2(n)])}
            onPress={() => { setOpen(false); onChange(`${pad2(hour)}:${pad2(n)}`); }} />)}
      </ListGroup>
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
    disabled={efforts.length <= 1} />;
}
