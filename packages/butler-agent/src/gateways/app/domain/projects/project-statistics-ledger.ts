import type { DashboardStatisticsView, DashboardStatisticSeries } from "../../interface/protocol/session-dashboard-contract.ts";
import type { ProjectDashboardSources } from "./project-dashboard-sources.ts";
import { projectDashboardBoard } from "./project-dashboard-board.ts";
import { sanitizePublicText } from "../../../../agent/events/public-text.ts";

type LedgerInput = NonNullable<Awaited<ReturnType<ProjectDashboardSources["statistics"]>>>;
export function statisticSeries(labels: string[], keys: string[]): DashboardStatisticSeries {
  return { keys, buckets: labels.map((label) => ({ label, values: Object.fromEntries(keys.map((key) => [key, []])) })) };
}

export function addStatistic(series: DashboardStatisticSeries, index: number, metric: string, key: string) {
  const values = series.buckets[index]?.values[metric];
  if (values && !values.includes(key)) values.push(key);
}

export function statisticDay(view: DashboardStatisticsView, at: string): number {
  const time = Date.parse(at);
  return view.days.findIndex((day) => time >= Date.parse(day.start) && time < Date.parse(day.end));
}

/** Pure projection: authoritative board lanes, ordinary completion events and
 * managed completion dispositions retain their different meanings. */
export function populateLedgerStatistics(view: DashboardStatisticsView, input: LedgerInput | null) {
  if (!input) return;
  const { snapshot, history } = input;
  const labels = view.days.map((day) => day.date);
  const metrics = ["created", "completed", "executed"];
  const cards = (kind: "work" | "task") => projectDashboardBoard(snapshot, kind, () => null).map((card) => {
    const sourceKey = `${kind}:${card.id}`;
    view.sources[sourceKey] = { title: card.title, at: card.updatedAt,
      source: { kind, id: card.id, revision: snapshot.revision } };
    const age = (Date.parse(view.observedAt) - Date.parse(card.updatedAt)) / 86400000;
    return { ...card, sourceKey, ageDays: Number.isFinite(age) && age >= 0 ? Math.floor(age) : null };
  });
  // The canonical Task completion command emits task_updated without its status.
  // A complete historical completion series cannot be reconstructed from it.
  view.work = { work: statisticSeries(labels, metrics), task: statisticSeries(labels, ["created"]),
    cards: { work: cards("work"), task: cards("task") }, excluded: 0, activity: [] };
  view.ledgerHistoryAvailable = Boolean(history);
  if (!history) return;
  const records = new Map(snapshot.records.map((record) => [`${record.kind}:${record.id}`, record]));
  const managedIds = new Set(snapshot.works.filter((work) => work.managed).map((work) => work.record.id));
  const unavailableIds = new Set(snapshot.works.filter((work) => work.availability !== "ready").map((work) => work.record.id));
  const seen = new Set<string>();
  const activity = new Map<string, { sourceKey: string; dates: Set<string>; changes: number }>();
  const events = [...history.ledger.map((event) => ({ ...event, managed: false })),
    ...history.managed.map((event) => ({ id: event.id, recordId: event.workId, kind: "work", at: event.at,
      action: event.action === "disposition" && event.status === "completed" ? "executed" : event.action, managed: true }))]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  for (const event of events) {
    const day = statisticDay(view, event.at);
    if (day < 0) continue;
    const key = `${event.kind}:${event.recordId}`;
    const record = records.get(key);
    if (!record || record.unavailable || unavailableIds.has(event.recordId)) { view.work.excluded++; continue; }
    if (!view.sources[key]) view.sources[key] = { title: sanitizePublicText(record.title, ""), at: record.updatedAt,
      source: { kind: record.kind, id: record.id, revision: snapshot.revision } };
    if (event.kind === "work" || event.kind === "task") {
      // Low-level tool results and mirrored header updates are not extra work activity.
      if (event.action === "result" || (!event.managed && managedIds.has(event.recordId) && event.action !== "created")) continue;
      addStatistic(view.activity, day, "work", key);
      if (event.kind === "work") {
        const item = activity.get(key) ?? { sourceKey: key, dates: new Set<string>(), changes: 0 };
        item.dates.add(view.days[day]!.date); item.changes++; activity.set(key, item);
      }
      if (["created", "completed", "executed"].includes(event.action)) {
        const identity = `${key}:${event.action}`;
        if (!seen.has(identity)) {
          addStatistic(view.work[event.kind], day, event.action, key); seen.add(identity);
        }
      }
    } else if (["spec", "plan", "report"].includes(event.kind) && ["created", "updated"].includes(event.action)) {
      addStatistic(view.materials, day, event.action, key);
      addStatistic(view.materialTypes, day, event.kind, key);
      addStatistic(view.activity, day, "materials", key);
    }
  }
  view.work.activity = [...activity.values()].map((item) => ({ ...item, dates: [...item.dates] }))
    .sort((a, b) => b.changes - a.changes || a.sourceKey.localeCompare(b.sourceKey));
  // Completed heads without a completion event are never given an invented date.
  view.work.excluded += snapshot.works.filter((work) => work.managed?.status === "completed" &&
    !history.managed.some((event) => event.workId === work.record.id && event.action === "disposition" && event.status === "completed")).length;
}
