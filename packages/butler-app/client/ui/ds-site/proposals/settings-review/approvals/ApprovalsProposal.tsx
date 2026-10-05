import { useEffect, useMemo, useState } from "react";
import { useAppLocale } from "@/app/copy";
import { confirmAction } from "@/app/confirmation";
import { notifyStatus } from "@/app/notifications";
import { CardList, EmptyLine, Input, Inline, NativeSelect, NativeSelectOption, Stack } from "@/butler-ds";
import { SettingsSection } from "@/components/settings/SettingsFormComponents";
import { SecurityPageProposal } from "./SecurityPageProposal";
import { t } from "../proposedCopy";
import type { StageState } from "../state";
import { grantFixture, groupGrants, type GrantKind, type GrantRow } from "./grants";
import { GrantRowView } from "./GrantRowView";

/** Search and the kind filter appear only past this many rows. */
const SEARCH_AFTER = 8;

function GrantList({ state }: { state: StageState }) {
  const locale = state.locale;
  const [rows, setRows] = useState<GrantRow[]>([]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<GrantKind | "all">("all");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setRows(groupGrants(grantFixture(state.approvals === "long"))); setQuery(""); setKind("all"); }, [state.approvals]);
  const kinds = useMemo(() => [...new Set(rows.map((row) => row.kind))], [rows]);
  const visible = rows.filter((row) => (kind === "all" || row.kind === kind) &&
    (!query.trim() || [row.target, row.cwd ?? "", ...row.places, row.project ?? "", t(locale, `settings.grants.kind.${row.kind}`)]
      .some((text) => text.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale)))));
  const revoke = async (row: GrantRow) => {
    if (row.scope === "always" && !await confirmAction(t(locale, "settings.grants.revokeAlwaysMessage"), {
      title: t(locale, "settings.grants.revokeAlwaysTitle"), confirmLabel: t(locale, "settings.grants.revoke"), destructive: true,
      details: [{ label: t(locale, `settings.grants.kind.${row.kind}`), text: row.target }],
    })) return;
    setBusy(row.key);
    // The real call: DELETE /authority-permissions/{grant_ref}?session_id=… for every ref in the row.
    window.setTimeout(() => {
      setRows((current) => current.filter((item) => item.key !== row.key));
      setBusy(null);
      notifyStatus(t(locale, "settings.grants.revoked"), { id: "grant-revoke", tone: "ok" });
    }, 250);
  };
  const sectionState = state.approvals === "loading" ? "loading" : state.approvals === "error" ? "error"
    : state.approvals === "empty" || rows.length === 0 ? "empty" : "ready";
  return (
    <SettingsSection
      id="grants"
      kind="list"
      title={t(locale, "settings.pageSections.grants")}
      description={t(locale, "settings.pageSectionDescriptions.grants")}
      state={sectionState}
      errorMessage={t(locale, "settings.grants.loadFailed")}
      emptyMessage={t(locale, "settings.grants.empty")}
      onRetry={() => undefined}
    >
      <Stack gap="sm">
        {rows.length > SEARCH_AFTER ? (
          <Inline>
            <Stack.Item basis="lg" minWidth="0">
              <Input type="search" aria-label={t(locale, "settings.grants.search")} placeholder={t(locale, "settings.grants.search")}
                value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
            </Stack.Item>
            <Stack.Item shrink={false}>
              <NativeSelect aria-label={t(locale, "settings.grants.filter")} value={kind}
                onChange={(event) => setKind(event.currentTarget.value as GrantKind | "all")}>
                <NativeSelectOption value="all">{t(locale, "settings.grants.filterAll")}</NativeSelectOption>
                {kinds.map((item) => <NativeSelectOption key={item} value={item}>{t(locale, `settings.grants.kind.${item}`)}</NativeSelectOption>)}
              </NativeSelect>
            </Stack.Item>
          </Inline>
        ) : null}
        <CardList empty={<EmptyMatch locale={locale} />}>
          {visible.map((row) => (
            <GrantRowView key={row.key} row={row} locale={locale} busy={busy === row.key} onRevoke={() => void revoke(row)} />
          ))}
        </CardList>
      </Stack>
    </SettingsSection>
  );
}

function EmptyMatch({ locale }: { locale: StageState["locale"] }) {
  return <EmptyLine message={t(locale, "settings.grants.noMatch")} />;
}

export function ApprovalsProposal({ state }: { state: StageState }) {
  useAppLocale();
  return <SecurityPageProposal grants={<GrantList state={state} />} />;
}
