import { useMemo, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { CardList, EmptyLine, Input, Inline, NativeSelect, NativeSelectOption, Stack } from "@/butler-ds";
import { GrantRow } from "./GrantRow";
import { useGrants } from "./useGrants";
import type { GrantKind } from "./grantRows";

const SEARCH_AFTER = 8;
export function GrantsSection({ grants }: { grants: ReturnType<typeof useGrants> }) {
  const locale = useAppLocale();
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }), [locale]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<GrantKind | "all">("all");
  const copy = appCopy.settings.grants;
  const kinds = [...new Set(grants.rows.map(row => row.kind))];
  const hasFilters = grants.rows.length > SEARCH_AFTER;
  const search = hasFilters ? query.trim().toLocaleLowerCase(locale) : "";
  const visible = grants.rows.filter(row => (!hasFilters || kind === "all" || row.kind === kind) &&
    (!search || [row.target, row.cwd ?? "", ...[...row.places.values()].map(title => title ?? copy.deletedChat), row.project ?? "", copy.kind[row.kind]]
      .some(text => text.toLocaleLowerCase(locale).includes(search))));
  return (
      <Stack gap="sm">
        {hasFilters && <Inline>
          <Stack.Item basis="lg" minWidth="0">
            <Input type="search" aria-label={copy.search} placeholder={copy.search} value={query} onChange={event => setQuery(event.currentTarget.value)} />
          </Stack.Item>
          <Stack.Item shrink={false}>
            <NativeSelect aria-label={copy.filter} value={kind} onChange={event => setKind(event.currentTarget.value as GrantKind | "all")}>
              <NativeSelectOption value="all">{copy.filterAll}</NativeSelectOption>
              {kinds.map(item => <NativeSelectOption key={item} value={item}>{copy.kind[item]}</NativeSelectOption>)}
            </NativeSelect>
          </Stack.Item>
        </Inline>}
        <CardList empty={<EmptyLine message={copy.noMatch} />}>
          {visible.map(row => <GrantRow key={row.key} row={row} dateFormatter={dateFormatter} busy={grants.busy.has(row.key)} onRevoke={() => void grants.revoke(row)} />)}
        </CardList>
      </Stack>
  );
}
