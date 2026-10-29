import { useEffect, useId, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { api } from "@/app/api";
import { useButlerStore } from "@/app/store";
import { notifyStatus } from "@/app/notifications";
import { Box, Button, ButtonContainer, EmptyLine, Field, FieldLabel, HistoryGroup, HistoryRow, IconButton, Input, MessageSquare, PageContainer, ScrollArea, Stack, Switch, Trash2, Typo } from "@/butler-ds";
import { HistoryClearDialog } from "./HistoryClearDialog";
import { historyCommand, openHistoryUrl, useHistoryVersion, type HistoryPageData, type HistoryVisit } from "./historyApi";

export function HistoryPage() {
  const locale = useAppLocale(), copy = appCopy.browser.history;
  const version = useHistoryVersion(s => s.version), onlyId = useId();
  const [search, setSearch] = useState(""), [only, setOnly] = useState(false), [cursor, setCursor] = useState("");
  const [page, setPage] = useState<HistoryPageData>({ items: [] }), [failed, setFailed] = useState(false), [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false), [selected, setSelected] = useState<number[]>([]), [clear, setClear] = useState(false), [busy, setBusy] = useState(false);
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
    try { for (let offset = 0; offset < ids.length; offset += 1000) await historyCommand("delete", { ids: ids.slice(offset, offset + 1000) }); setSelected([]); setSelecting(false); }
    catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); }
    finally { setBusy(false); }
  }
  const stopSelecting = () => { setSelecting(false); setSelected([]); };
  const toggle = (id: number, on: boolean) => setSelected(ids => on ? [...ids, id] : ids.filter(other => other !== id));
  const open = (url: string) => void openHistoryUrl(url).catch(() => notifyStatus(appCopy.browser.failed, { tone: "error" }));
  const groups = new Map<string, HistoryVisit[]>();
  for (const visit of page.items) {
    const day = new Date(visit.visitTime).toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric", weekday: "long" });
    const group = groups.get(day);
    if (group) group.push(visit); else groups.set(day, [visit]);
  }
  const actions = (visit: HistoryVisit) => <ButtonContainer size="icon-sm">
    {visit.conversationId && <IconButton label={appCopy.browser.openConversation} onClick={() => useButlerStore.getState().openSession(visit.conversationId!)}><MessageSquare size="md" /></IconButton>}
    <IconButton label={`${appCopy.browser.remove}: ${visit.title || visit.url}`} disabled={busy} onClick={() => void remove([visit.id])}><Trash2 size="md" /></IconButton>
  </ButtonContainer>;
  return <ScrollArea fill dataTestClass="history-page"><PageContainer width="narrow" gutter="xl"><Box paddingY="xl"><Stack gap="xl">
    <Stack gap="md"><Input aria-label={copy.search} placeholder={copy.search} value={search} onChange={event => setSearch(event.target.value)} />
      <Stack align="row" justify="between" cross="end" gap="sm"><Field><FieldLabel htmlFor={onlyId}>{copy.butlerOnly}</FieldLabel><Switch id={onlyId} checked={only} onCheckedChange={setOnly} /></Field>
        <Stack.Item shrink={false}>{selecting ? <Stack align="row" cross="center" gap="md"><Typo.Caption tone="secondary" numeric="tabular">{appCopy.library.selected(selected.length)}</Typo.Caption>
          <ButtonContainer size="sm"><Button size="sm" variant="ghost" onClick={stopSelecting}>{appCopy.browser.cancel}</Button>
            <Button size="sm" variant="destructive" disabled={busy || !selected.length} onClick={() => void remove(selected)}>{appCopy.browser.remove}</Button></ButtonContainer></Stack>
          : <ButtonContainer size="sm"><Button size="sm" variant="ghost" onClick={() => setSelecting(true)} disabled={!page.items.length}>{appCopy.library.select}</Button>
            <Button size="sm" variant="outline" onClick={() => setClear(true)}>{copy.clear}</Button></ButtonContainer>}</Stack.Item></Stack></Stack>
    {groups.size > 0 && <Stack gap="lg">{Array.from(groups, ([day, visits]) => <HistoryGroup key={day} title={day}>
      {visits.map(visit => <HistoryRow key={visit.id} rowId={visit.id} title={visit.title} url={visit.url} iconSrc={visit.favicon || undefined} dateTime={visit.visitedAt}
        time={new Date(visit.visitTime).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })} onOpen={() => open(visit.url)} actions={actions(visit)}
        selecting={selecting} selected={selected.includes(visit.id)} onSelectedChange={on => toggle(visit.id, on)} />)}
    </HistoryGroup>)}</Stack>}
    {!page.items.length && <EmptyLine message={failed ? appCopy.browser.failed : loading ? appCopy.browser.loading : copy.empty} />}
    {page.next_cursor && <Button size="sm" disabled={loading} onClick={() => setCursor(page.next_cursor!)}>{appCopy.browser.loadMore}</Button>}
    {clear && <HistoryClearDialog onClose={() => setClear(false)} />}
  </Stack></Box></PageContainer></ScrollArea>;
}
