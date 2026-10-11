import { appCopy } from "@/app/copy";
import { Field, FieldLabel, Input, Stack } from "@/butler-ds";
import { setFilters, useLibraryFilters } from "./libraryFilters";

/** Calendar dates include the whole final day in the user's timezone. */
export function DateRangeFields() {
  const filters = useLibraryFilters(), copy = appCopy.library;
  const localDate = (iso?: string) => iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : "";
  const set = (key: "since" | "until", value: string) => {
    const time = value ? new Date(`${value}T${key === "since" ? "00:00:00.000" : "23:59:59.999"}`).toISOString() : undefined;
    setFilters({ date: undefined, [key]: time });
  };
  return <Stack gap="sm" onKeyDown={(event) => event.stopPropagation()}>
    <Field><FieldLabel htmlFor="library-since">{copy.since}</FieldLabel><Input id="library-since" type="date" value={localDate(filters.since)} max={localDate(filters.until) || undefined} onChange={(e) => set("since", e.target.value)} /></Field>
    <Field><FieldLabel htmlFor="library-until">{copy.until}</FieldLabel><Input id="library-until" type="date" value={localDate(filters.until)} min={localDate(filters.since) || undefined} onChange={(e) => set("until", e.target.value)} /></Field>
  </Stack>;
}
