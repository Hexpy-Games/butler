import { useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import type { CanonActivity, CanonActivityPage, CanonConflictBody, CanonStatus, EpicDetail, PlanCards } from "@/app/canonApi.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import { Activity, ActivityFeed, ArrowRight, Button, ButtonContainer, CheckIcon, Circle, CircleAlert, FileText, Flag, MessageSquare, Pencil, Plus, Stack, Typo, XIcon } from "@/butler-ds";
import { canonActorLabel } from "./canonActorLabel.ts";
import { useCanonPersonName } from "./useCanonPersonName.ts";
import { LOCAL_PERSON_ID } from "./localPerson.ts";
export function EpicActivity({ epic, plans }: { epic: EpicDetail; plans: PlanCards[] }) {
  const locale = useAppLocale();
  const person = useCanonPersonName();
  const [page, setPage] = useState<CanonActivityPage>({ activity: epic.activity ?? [], activity_before: epic.activity_before ?? null });
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const epicId = useRef(epic.id);
  useEffect(() => {
    if (epicId.current !== epic.id) {
      generation.current++;
      epicId.current = epic.id;
      setBusy(false);
      setPage({ activity: epic.activity ?? [], activity_before: epic.activity_before ?? null });
    } else {
      setPage(current => ({
        activity: [...new Map([...current.activity, ...(epic.activity ?? [])].map(row => [row.seq, row])).values()].sort((a, b) => b.seq - a.seq),
        activity_before: current.activity.length ? current.activity_before : epic.activity_before ?? null,
      }));
    }
  }, [epic]);
  useEffect(() => () => { generation.current++; }, []);
  const more = async () => {
    if (busy || page.activity_before === null) return;
    const epoch = generation.current;
    setBusy(true);
    try {
      const older = await api<CanonActivityPage>(`/canon/epics/${encodeURIComponent(epic.id)}/activity?before=${page.activity_before}`);
      if (epoch === generation.current) setPage(current => ({ activity: [...new Map([...current.activity, ...older.activity].map(row => [row.seq, row])).values()].sort((a, b) => b.seq - a.seq), activity_before: older.activity_before }));
    } catch (error) { if (epoch === generation.current) notifyError(error, appCopy.interfaceFeedback.requestFailed); }
    finally { if (epoch === generation.current) setBusy(false); }
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
      id: String(row.seq), icon: activityIcon(row), title: canonActorLabel(row.actor, person), meta: relative(row.at),
      description: <Typo.Text wrap="pre">{activityDescription(row, person, plans)}</Typo.Text>,
    }))} />
    {page.activity_before !== null && <ButtonContainer size="sm" justify="end"><Button size="sm" variant="ghost" disabled={busy} onClick={() => void more()}>{copy.more}</Button></ButtonContainer>}
  </Stack>;
}

function conflictBody(row: CanonActivity): CanonConflictBody | null {
  if (row.kind !== "edited" || row.body === null) return null;
  try {
    const body = JSON.parse(row.body);
    if (body?.conflict === true && body.fields && Object.getPrototypeOf(body.fields) === Object.prototype) return body;
  } catch { return null; }
  return null;
}

function activityDescription(row: CanonActivity, person: string, plans: PlanCards[]): string {
  const copy = appCopy.canon;
  const conflict = conflictBody(row);
  if (conflict) {
    const lines = [copy.conflict];
    const field = copy.online.conflictField;
    for (const [key, value] of Object.entries(conflict.fields)) {
      switch (key) {
        case "title": if (typeof value === "string") lines.push(field(copy.title, value)); break;
        case "description": if (typeof value === "string") lines.push(field(copy.description, value)); break;
        case "assignee":
          if (value === null || typeof value === "string") lines.push(field(copy.assignee, value === LOCAL_PERSON_ID ? person : value ?? copy.none));
          break;
        case "canon_status":
          if (typeof value === "string" && Object.hasOwn(copy.statuses, value)) lines.push(field(copy.status, copy.statuses[value as CanonStatus]));
          break;
        case "plan_id":
          if (value === null || typeof value === "string") lines.push(field(copy.plan, value === null ? copy.backlog : plans.find(plan => plan.id === value)?.title ?? copy.planMissing));
          break;
      }
    }
    return lines.join("\n");
  }
  switch (row.kind) {
    case "status": return row.from && row.to ? `${copy.statuses[row.from]} → ${copy.statuses[row.to]}` : row.summary;
    case "criterion_confirmed": return copy.criterionActivity(row.summary, true);
    case "criterion_unconfirmed": return copy.criterionActivity(row.summary, false);
    case "edited": return copy.mcp.editedActivity;
    case "moved": return `${copy.plan} → ${row.summary || copy.backlog}`;
    case "created": return copy.mcp.createdActivity;
    case "comment": return row.body ?? row.summary;
    case "proposal_opened": return `${copy.mcp.proposal} · ${row.summary}`;
    case "proposal_applied": return copy.mcp.appliedActivity;
    case "proposal_declined": return copy.mcp.declinedActivity;
    default: return row.summary;
  }
}

function activityIcon(row: CanonActivity) {
  const icons: Record<string, typeof Activity> = { comment: MessageSquare, status: ArrowRight, created: Plus, edited: Pencil, moved: Flag,
    criterion_confirmed: CheckIcon, criterion_unconfirmed: Circle, proposal_opened: FileText, proposal_applied: CheckIcon, proposal_declined: XIcon };
  const Icon = conflictBody(row) ? CircleAlert : icons[row.kind] ?? Activity;
  return <Icon size="md" aria-hidden="true" />;
}
