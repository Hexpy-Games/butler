import { useEffect, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { api } from "@/app/api";
import { useButlerStore } from "@/app/store";
import { notifyStatus } from "@/app/notifications";
import { Box, Button, ButtonContainer, CheckIcon, EmptyLine, IconButton, Input, NavRow, PageContainer, ScrollArea, Square, Stack, Switch, Trash2, Typo } from "@/butler-ds";
import { HistoryClearDialog } from "./HistoryClearDialog";
import { historyCommand, openHistoryUrl, useHistoryVersion, type HistoryPageData, type HistoryVisit } from "./historyApi";

export function HistoryPage() {
  const locale = useAppLocale(), copy = appCopy.browser.history;
  const version = useHistoryVersion(s => s.version);
  const [search, setSearch] = useState(""), [only, setOnly] = useState(false), [cursor, setCursor] = useState("");
  const [page, setPage] = useState<HistoryPageData>({ items: [] }), [failed, setFailed] = useState(false), [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number[]>([]), [clear, setClear] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => { setCursor(""); setSelected([]); }, [search, only, version]);
  useEffect(() => {
    let active = true; setLoading(true); setFailed(false);
    void api<HistoryPageData>(`/browser-history?${new URLSearchParams({ q: search, butlerOnly: String(only), cursor })}`).then(next => {
      if (active) setPage(prior => ({ ...next, items: cursor ? [...prior.items, ...next.items] : next.items }));
    }, () => { if (active) setFailed(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [search, only, cursor, version]);
  async function remove(ids: number[]) {
    setBusy(true);
    try { for (let offset = 0; offset < ids.length; offset += 1000) await historyCommand("delete", { ids: ids.slice(offset, offset + 1000) }); setSelected([]); }
    catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); }
    finally { setBusy(false); }
  }
  const groups = new Map<string, HistoryVisit[]>();
  for (const visit of page.items) {
    const day = new Date(visit.visitTime).toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric", weekday: "long" });
    const group = groups.get(day);
    if (group) group.push(visit); else groups.set(day, [visit]);
  }
  return <ScrollArea fill dataTestClass="history-page"><PageContainer width="full" gutter="xl"><Box paddingY="xl"><Stack gap="xl">
    <Input aria-label={copy.search} placeholder={copy.search} value={search} onChange={event => setSearch(event.target.value)} />
    <Stack align="row" wrap justify="between" cross="center"><Stack align="row" cross="center" gap="sm"><Switch aria-label={copy.butlerOnly} checked={only} onCheckedChange={setOnly} /><Typo.Label>{copy.butlerOnly}</Typo.Label></Stack>
      <ButtonContainer size="sm"><Button size="sm" variant="ghost" onClick={() => setSelected(page.items.map(v => v.id))} disabled={!page.items.length}>{appCopy.library.select}</Button>
        {selected.length > 0 && <Button size="sm" disabled={busy} onClick={() => void remove(selected)}>{`${appCopy.browser.remove} · ${selected.length}`}</Button>}
        <Button size="sm" variant="outline" onClick={() => setClear(true)}>{copy.clear}</Button></ButtonContainer></Stack>
    {Array.from(groups, ([day, visits]) => <Stack key={day} gap="sm"><Typo.H4>{day}</Typo.H4>
      {visits.map(visit => <Stack key={visit.id} data-history-id={visit.id} align="row" gap="sm" cross="center">
        <IconButton label={`${appCopy.library.select}: ${visit.title}`} pressed={selected.includes(visit.id)} role="checkbox" aria-checked={selected.includes(visit.id)} onClick={() => setSelected(ids => ids.includes(visit.id) ? ids.filter(id => id !== visit.id) : [...ids, visit.id])}>{selected.includes(visit.id) ? <CheckIcon size="sm" /> : <Square size="sm" />}</IconButton>
        <Stack grow><NavRow label={visit.title || visit.url} meta={<Typo.Caption tone="secondary" truncate>{new URL(visit.url).host}</Typo.Caption>} onClick={() => void openHistoryUrl(visit.url).catch(() => notifyStatus(appCopy.browser.failed, { tone: "error" }))} /></Stack>
        <Typo.Caption tone="secondary">{new Date(visit.visitTime).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</Typo.Caption>
        {visit.conversationId && <Button size="xs" variant="ghost" onClick={() => useButlerStore.getState().openSession(visit.conversationId!)}>{appCopy.browser.openConversation}</Button>}
        <IconButton label={`${appCopy.browser.remove}: ${visit.title}`} disabled={busy} onClick={() => void remove([visit.id])}><Trash2 size="sm" /></IconButton>
      </Stack>)}</Stack>)}
    {!page.items.length && <EmptyLine message={failed ? appCopy.browser.failed : loading ? appCopy.browser.loading : copy.empty} />}
    {page.next_cursor && <Button size="sm" disabled={loading} onClick={() => setCursor(page.next_cursor!)}>{appCopy.browser.loadMore}</Button>}
    {clear && <HistoryClearDialog onClose={() => setClear(false)} />}
  </Stack></Box></PageContainer></ScrollArea>;
}
