import type { Database } from "bun:sqlite";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import type { DashboardStatisticsView } from "../../interface/protocol/session-dashboard-contract.ts";
import type { ProjectDashboardSources } from "./project-dashboard-sources.ts";
import { populateLedgerStatistics, statisticSeries } from "./project-statistics-ledger.ts";
import { populateSessionStatistics } from "./project-statistics-sessions.ts";

export function projectStatistics(db: Database, projectId: string, period: 7 | 30 | 90, timezone: string,
  ledger: Awaited<ReturnType<ProjectDashboardSources["statistics"]>>, now = new Date()): DashboardStatisticsView {
  const days = projectDayRanges(timezone, period, now);
  const labels = days.map((day) => day.date);
  const outcomes = ["delivered", "failed", "cancelled"];
  const view: DashboardStatisticsView = { timezone, period, observedAt: now.toISOString(), days, sources: {}, work: null,
    ledgerHistoryAvailable: false, sessionHistoryAvailable: false, activity: statisticSeries(labels, ["conversations", "work", "materials"]),
    materials: statisticSeries(labels, ["created", "updated", "artifacts"]),
    materialTypes: statisticSeries(labels, ["spec", "plan", "report", "artifacts"]),
    execution: { outcomes: statisticSeries(labels, outcomes),
      duration: statisticSeries(["under30s", "under2m", "under10m", "over10m"], outcomes), excluded: 0 },
    usage: { status: "unavailable", reason: "project_usage_not_collected" } };
  // Discard the entire session projection on a read/limit failure, including any
  // rows read before the failure. Ledger metadata remains independently usable.
  const sessionView = structuredClone(view);
  try {
    db.transaction(() => populateSessionStatistics(db, projectId, sessionView))();
    if (Object.keys(sessionView.sources).length > 20_000) throw new Error("project_statistics_limit");
    Object.assign(view, sessionView, { sessionHistoryAvailable: true });
  } catch { /* Availability is explicit; partial counts must not look complete. */ }
  populateLedgerStatistics(view, ledger);
  view.activity.keys = view.activity.keys.filter((key) => key === "conversations" ? view.sessionHistoryAvailable
    : key === "work" ? view.ledgerHistoryAvailable : view.sessionHistoryAvailable || view.ledgerHistoryAvailable);
  for (const series of [view.materials, view.materialTypes]) {
    series.keys = series.keys.filter((key) => key === "artifacts" ? view.sessionHistoryAvailable : view.ledgerHistoryAvailable);
  }
  if (Object.keys(view.sources).length > 20_000) throw new Error("project_statistics_limit");
  return view;
}

/** Calendar labels are advanced as dates; UTC boundaries are independently resolved in the IANA zone. */
export function projectDayRanges(timezone: string, period: 7 | 30 | 90, now: Date) {
  if (typeof timezone !== "string" || !timezone || timezone.length > 100 || ![7, 30, 90].includes(period) || !Number.isFinite(now.getTime())) {
    throw new AppStoreOperationError(400, "invalid_statistics_query", "Invalid statistics query.");
  }
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", calendar: "gregory", numberingSystem: "latn" }); }
  catch { throw new AppStoreOperationError(400, "invalid_timezone", "Invalid timezone."); }
  const dateAt = (ms: number) => {
    const parts = formatter.formatToParts(ms);
    return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)!.value).join("-");
  };
  const today = dateAt(now.getTime());
  const calendarDate = (offset: number) => {
    const day = new Date(`${today}T00:00:00.000Z`); day.setUTCDate(day.getUTCDate() + offset);
    return day.toISOString().slice(0, 10);
  };
  const boundary = (date: string) => {
    const nominal = Date.parse(`${date}T00:00:00.000Z`);
    let lo = nominal - 36 * 3600000, hi = nominal + 36 * 3600000;
    // Includes midnight transitions and skipped dates (whose start equals the next date's start).
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (dateAt(mid) < date) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const labels = Array.from({ length: period + 1 }, (_, index) => calendarDate(index - period + 1));
  const boundaries = labels.map(boundary);
  return labels.slice(0, -1).map((date, index) => ({ date, start: new Date(boundaries[index]!).toISOString(),
    end: new Date(Math.min(boundaries[index + 1]!, now.getTime())).toISOString(), partial: date === today }));
}
