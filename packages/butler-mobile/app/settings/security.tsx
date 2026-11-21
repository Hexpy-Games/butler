import { useCallback, useEffect, useState } from "react";
import { getAppCopy, type AppCopy } from "../../../butler-i18n/src/index.ts";
import { GatewayError } from "../../../butler-protocol/src/client/index.ts";
import { useConversation } from "@/conversation/live";
import { ListGroup, ListGroupItem, Button, IconButton, icons, ListRow, Sheet, Text, TextField, showToast } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { LoadState, SettingsScreen } from "@/settings/layout";
import { SelectRow } from "@/settings/rows";
import { groupGrants, type GrantedRow } from "@/settings/grantRows";
import type { AuthorityPermissionsView, GrantKind } from "@/settings/types";

function useGrants() {
  const { client, reconcile, subscribe } = useConversation();
  const copy = getAppCopy(useAppLocale()).settings.grants;
  const [rows, setRows] = useState<GrantedRow[] | null>(null), [error, setError] = useState(false), [busy, setBusy] = useState<string>();
  const reload = useCallback(async () => {
    if (!client) return;
    try { const result = await client.request<AuthorityPermissionsView>("/authority-permissions"); setRows(groupGrants(result.permissions)); setError(false); }
    catch { setError(true); }
  }, [client]);
  useEffect(() => { void reload(); }, [reload, reconcile]);
  useEffect(() => subscribe(event => { if (event.type.startsWith("authority.")) void reload(); }), [subscribe, reload]);
  const revoke = async (row: GrantedRow) => {
    if (!client || busy) return;
    setBusy(row.key);
    try {
      try { await client.request("/authority-permissions/revoke", { method: "POST", body: { grants: row.refs } }); }
      catch (error) { if (!(error instanceof GatewayError && error.code === "authority_permission_not_found")) throw error; }
      setRows(old => old?.filter(item => item.key !== row.key) ?? null);
      showToast({ message: copy.revoked, tone: "success" }); await reload();
    } catch { showToast({ message: copy.revokeFailed, tone: "error" }); }
    finally { setBusy(undefined); }
  };
  return { rows, error, busy, reload, revoke };
}

function where(row: GrantedRow, copy: AppCopy["settings"]["grants"]) {
  if (row.scope === "always") return "";
  if (row.scope === "project") return row.project ?? "";
  if (row.places.size > 1) return copy.conversations(row.places.size);
  return [...row.places.values()][0] || copy.deletedChat;
}

export default function SecuritySettings() {
  const locale = useAppLocale(), app = getAppCopy(locale), S = app.settings, copy = S.grants, M = useMobileCopy();
  const grants = useGrants();
  const [query, setQuery] = useState(""), [kind, setKind] = useState<GrantKind | "all">("all"), [selected, select] = useState<GrantedRow>();
  const rows = grants.rows ?? [], hasFilters = rows.length > 8;
  const search = hasFilters ? query.trim().toLocaleLowerCase(locale) : "";
  const kinds = [...new Set(rows.map(row => row.kind))];
  const visible = rows.filter(row => (!hasFilters || kind === "all" || row.kind === kind) && (!search ||
    [row.target, row.cwd ?? "", ...[...row.places.values()].map(title => title ?? copy.deletedChat), row.project ?? "", copy.kind[row.kind]]
      .some(text => text.toLocaleLowerCase(locale).includes(search))));
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
  return <SettingsScreen title={S.sections.security}>
    <ListGroup label={S.pageSections.grants}>
      {!grants.rows || grants.error ? <LoadState error={grants.error} message={copy.loadFailed} onRetry={grants.reload} /> : <>
        {hasFilters ? <><ListGroupItem><TextField label={copy.search} value={query} onChangeText={setQuery} /></ListGroupItem>
          <SelectRow<GrantKind | "all"> title={copy.filter} value={kind} options={[{ value: "all", label: copy.filterAll }, ...kinds.map(value => ({ value, label: copy.kind[value] }))]} onSelect={setKind} /></> : null}
        {visible.map(row => <ListRow key={row.key} title={copy.kind[row.kind]}
          description={`${(row.target || copy.targetUnknown).split("\n")[0]}\n${[copy.scope[row.scope], where(row, copy), row.cwd ? copy.cwd(row.cwd) : ""].filter(Boolean).join(" · ")}`}
          meta={date.format(new Date(row.createdAt))} trailing={<IconButton icon={icons.Delete} label={copy.revoke} disabled={Boolean(grants.busy)}
            loading={grants.busy === row.key} onPress={() => row.scope === "always" ? select(row) : void grants.revoke(row)} />} />)}
        {!visible.length ? <ListGroupItem><Text variant="caption">{rows.length ? copy.noMatch : copy.empty}</Text></ListGroupItem> : null}
      </>}
    </ListGroup>
    <Sheet open={Boolean(selected)} onClose={() => select(undefined)} title={copy.revokeAlwaysTitle} description={copy.revokeAlwaysMessage} cancelLabel={M.settings.cancel}
      action={<Button variant="destructive" label={copy.revoke} disabled={Boolean(grants.busy)} onPress={() => { if (selected) { void grants.revoke(selected); select(undefined); } }} />}>
      {selected ? <ListRow title={copy.kind[selected.kind]} description={selected.target || copy.targetUnknown} /> : null}
    </Sheet>
  </SettingsScreen>;
}
