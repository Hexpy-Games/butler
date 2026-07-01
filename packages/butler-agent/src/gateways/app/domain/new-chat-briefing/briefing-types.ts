import type {
  NewChatBriefingSuggestion,
  NewChatBriefingView,
} from "../../interface/protocol/app-protocol.ts";

export type AppLocale = "ko" | "en";

export interface BuildNewChatBriefingInput {
  butlerData: string;
  preferredLocale: AppLocale;
  date?: string | null;
  now?: Date;
  project?: ProjectBriefingInput;
}

export interface ConsolidationRunSummary {
  run_id?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
}

export interface ProjectBriefingInput {
  id: string;
  displayName: string;
  documents?: unknown;
}

export type BriefingFallbackCopy = {
  title: string;
  description: string;
  suggestions: NewChatBriefingSuggestion[];
};

export type BriefingSource = NewChatBriefingView["source"];
