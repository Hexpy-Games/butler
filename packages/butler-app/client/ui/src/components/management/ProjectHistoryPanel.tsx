import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { rememberDashboardLoadedCount, useProjectDashboardState } from "@/app/projectDashboardState.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, ChevronRight, CheckCircle2, FileText, MessageSquare, NavRow, Notice, Section, Stack, Typo } from "@/butler-ds";
import styles from "./ProjectHistoryPanel.module.css";
import information from "./ProjectInformation.module.css";
import type { ProjectDashboardDocument } from "@/app/types.ts";
import type { DashboardHistoryPage } from "../../../../../../butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";

export function ProjectHistoryPanel({ projectId, onSelect, onOpenSession }: { projectId: string; onSelect: (document: ProjectDashboardDocument) => void; onOpenSession: (id: string) => void }) {
  const locale = useAppLocale();
  const [page, setPage] = useState<DashboardHistoryPage | null>(null);
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(false);
    const query = new URLSearchParams({ limit: "50", ...(cursor ? { cursor } : {}) });
    const request = async () => {
      let next = await api<DashboardHistoryPage>(`/projects/${encodeURIComponent(projectId)}/dashboard/history?${query}`);
      const wanted = useProjectDashboardState.getState().projects[projectId]?.loadedCounts?.history ?? 50;
      while (!cursor && !cancelled && next.status === "ready" && next.nextCursor && next.events.length < wanted) {
        query.set("cursor", next.nextCursor);
        const more = await api<DashboardHistoryPage>(`/projects/${encodeURIComponent(projectId)}/dashboard/history?${query}`);
        next = more.status === "ready" ? { ...more, events: [...next.events, ...more.events] } : more;
      }
      return next;
    };
    request()
      .then((next) => { if (!cancelled) setPage((old) => cursor && old?.status === "ready" && next.status === "ready"
        ? { ...next, events: [...old.events, ...next.events] } : next); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [projectId, cursor, attempt]);
  useEffect(() => {
    if (page?.status === "ready") rememberDashboardLoadedCount(projectId, "history", page.events.length);
  }, [page, projectId]);
  const copy = appCopy.projectSignpost;
  if (error || page?.status === "unavailable") return <Notice tone="error" message={copy.unavailable} action={<Button variant="outline"
    onClick={() => { setCursor(undefined); setPage(null); setAttempt((value) => value + 1); }}>{appCopy.feedback.retry}</Button>} />;
  if (!page) return <Typo.Body role="status">{appCopy.feedback.dashboardLoading}</Typo.Body>;
  const groups = new Map<string, typeof page.events>();
  for (const event of page.events) {
    const date = new Date(event.at).toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });
    const items = groups.get(date) ?? [];
    items.push(event);
    groups.set(date, items);
  }
  return <Stack gap="xl">
    {page.ledgerUnavailable && <Typo.Caption>{copy.historyLedgerUnavailable}</Typo.Caption>}
    {[...groups].map(([date, events]) => <Section key={date} title={date}>
      <div className={styles.timeline}>{events.map((event) => <div key={event.id} className={styles.event}>
        <span className={styles.marker}>{event.action === "completed" ? <CheckCircle2 /> : event.session ? <MessageSquare /> : <FileText />}</span>
        <Stack gap="xs">
          <NavRow label={<span className={information.title}>{event.title}</span>} multiline actions={<ChevronRight />}
      meta={<Typo.Caption className={information.summary}>{[new Date(event.at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }), event.action === "completed" ? copy.recordedCompletion : copy[event.action],
        event.artifactCount ? copy.linkedResults(event.artifactCount) : null].filter(Boolean).join(" · ")}</Typo.Caption>}
      onClick={() => onSelect({ id: event.source.id, revision: event.source.revision, project_id: projectId,
        kind: event.source.kind === "spec" ? "spec" : event.source.kind === "report" ? "report" : "plan",
        document_type: event.source.kind as ProjectDashboardDocument["document_type"], title: event.title,
        markdown: "", safe_path_label: event.source.id, updated_at: event.at })} />
          {event.session && <Button variant="borderless" size="xs" className={styles.session} onClick={() => onOpenSession(event.session!.id)}>
            <MessageSquare /><span className={styles.sessionTitle}>{event.session.title}</span><ChevronRight />
          </Button>}
        </Stack>
      </div>)}</div>
    </Section>)}
    {page.events.length === 0 && !page.nextCursor && <Typo.Body>{copy.noHistory}</Typo.Body>}
    {page.nextCursor && <Button variant="borderless" onClick={() => setCursor(page.nextCursor!)}>{copy.loadMore}</Button>}
  </Stack>;
}
