import type { CanonHoldPanel, CanonTakeHerePanel } from "../../../shared/canon-queue-contracts.ts";

/** Open origin kind allows future initiated work and connector messages. */
export interface InitiatedOrigin {
  kind: string;
  label?: string;
  quiet: boolean;
  automation_id?: string;
  automation_title?: string;
  relation_id?: string;
  work_session_id?: string;
  work_title?: string;
  reason_code?: string;
  state?: "retrying" | "failed";
  run_id?: string;
  /** Raw authority approval; narrowed by the shared approval normalizer. */
  approval?: unknown;
  plan_title?: string;
  epic_title?: string;
  epic_id?: string;
  panel?: PatternProposalPanel | SchedulePausePanel | CanonHoldPanel | CanonTakeHerePanel;
}
export interface InitiatedSchedule {
  type: "daily" | "weekdays" | "weekly" | "interval" | "once";
  time?: string;
  weekdays?: number[];
}
export interface PatternCandidate {
  pattern_id: string;
  state: "pending" | "accepted" | "declined";
  title: string;
  action: { title: string; schedule: InitiatedSchedule; deliver_to: "chats" };
  evidence: { count: number; first_at: string; last_at: string };
  automation_id?: string;
}
export interface PatternProposalPanel {
  kind: "pattern_proposal";
  bundle_id: string;
  candidates: PatternCandidate[];
}
export interface SchedulePausePanel {
  kind: "schedule_pause";
  automation_id: string;
  state: "pending" | "continued" | "stopped";
  title: string;
  schedule: InitiatedSchedule;
  unopened_count: number;
}
