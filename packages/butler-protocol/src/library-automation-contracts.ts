import type { ElementFileRef } from "./browser-element.ts";
export type LibraryKind = "scrap" | "document" | "bookmark" | "output";
export interface LibraryItem {
  id: string; kind: LibraryKind | "doc"; title: string; url: string; capturedAt: string; updatedAt?: string;
  site?: string; session?: string; file?: ElementFileRef; output?: string; image_url?: string; crop?: string;
  published?: { page_id: string; url: string };
}
export interface LibraryPage { items: LibraryItem[]; next_cursor?: string | null }
export interface LibraryFacets { total: number }
export interface CalendarSchedule { kind: string; time: string; weekdays: number[]; tz: string }
export interface AutomationSummary {
  id: string; title: string; state: string; target_session_id: string; target_label: string | null;
  interval_seconds: number; schedule_type: string; schedule: CalendarSchedule | null;
  next_run_at?: string; last_run_at?: string; last_run_state: string; last_safe_error_code?: string;
}
export interface AutomationDetail extends AutomationSummary {
  prompt_body: string; access_mode: string; model?: string; browser_signin: boolean; browser_payment: boolean;
  run_at?: string; start_at?: string;
}
export interface AutomationRunSummary {
  id: string; automation_id: string; target_session_id: string; state: string; started_at: string;
  safe_error_code?: string; turn_id?: string;
}
export interface AutomationRunPage { runs: AutomationRunSummary[]; next_cursor?: string }
