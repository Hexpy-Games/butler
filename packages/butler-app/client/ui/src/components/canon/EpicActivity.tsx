import { useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import type { CanonActivityPage, EpicDetail } from "@/app/canonApi.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import { ActivityFeed, Button, ButtonContainer, Stack, Typo } from "@/butler-ds";
import { canonActorLabel } from "./canonActorLabel.ts";
import { useCanonPersonName } from "./useCanonPersonName.ts";
export function EpicActivity({ epic }: { epic: EpicDetail }) {
  const locale = useAppLocale();
  const person = useCanonPersonName();
  const [page, setPage] = useState<CanonActivityPage>({ activity: epic.activity ?? [], activity_before: epic.activity_before ?? null });
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setPage({ activity: epic.activity ?? [], activity_before: epic.activity_before ?? null });
    return () => { generation.current++; };
  }, [epic]);
  const more = async () => {
    if (busy || page.activity_before === null) return;
    const epoch = generation.current;
    setBusy(true);
    try {
      const older = await api<CanonActivityPage>(`/canon/epics/${encodeURIComponent(epic.id)}/activity?before=${page.activity_before}`);
      if (epoch === generation.current) setPage(current => ({ activity: [...current.activity, ...older.activity], activity_before: older.activity_before }));
    } catch (error) { if (epoch === generation.current) notifyError(error, appCopy.interfaceFeedback.requestFailed); }
    finally { setBusy(false); }
  };
  const time = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const relative = (at: number) => {
    const seconds = Math.round((at - Date.now()) / 1000);
    const unit = Math.abs(seconds) < 60 ? "second" : Math.abs(seconds) < 3600 ? "minute" : Math.abs(seconds) < 86400 ? "hour" : "day";
    return time.format(Math.round(seconds / ({ second: 1, minute: 60, hour: 3600, day: 86400 }[unit])), unit);
  };
  const copy = appCopy.canon.mcp;
  return <Stack gap="sm" data-test-class="canon-activity">
    <ActivityFeed title={copy.activity} emptyLabel={copy.noActivity} items={page.activity.map(row => ({
      id: String(row.seq), title: canonActorLabel(row.actor, person), meta: relative(row.at),
      description: <Typo.Text wrap="pre">{row.kind === "comment" ? row.body ?? row.summary : row.summary}</Typo.Text>,
    }))} />
    {page.activity_before !== null && <ButtonContainer size="sm" justify="end"><Button size="sm" variant="ghost" disabled={busy} onClick={() => void more()}>{copy.more}</Button></ButtonContainer>}
  </Stack>;
}
