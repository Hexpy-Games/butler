//! Project dashboard contracts (shared/dashboard-space-contracts.ts:94-289): the dashboard view,
//! its overview, briefing, preferences, statistics, and the records, materials, history and
//! artifact pages. The navigation part of the same file is in `navigation.rs`.
use std::collections::BTreeMap;

use serde::Deserialize;

use super::{ProjectDashboardDocument, ProjectSummary, SessionArtifactSummary};

/// A record a dashboard fact points at (`{ kind, id, revision }`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct DashboardSourceRef {
    pub(crate) kind: String,
    pub(crate) id: String,
    pub(crate) revision: String,
}

/// A conversation a dashboard fact points at (`{ id, title }`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct DashboardSessionRef {
    pub(crate) id: String,
    pub(crate) title: String,
}

/// `{ done, total }`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub(crate) struct DashboardProgress {
    pub(crate) done: i64,
    pub(crate) total: i64,
}

/// TS: dashboard-space-contracts.ts:95 DashboardArtifactPage (inline item).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct DashboardArtifact {
    #[serde(flatten)]
    pub(crate) artifact: SessionArtifactSummary,
    pub(crate) session_title: String,
    pub(crate) revision: String,
    pub(crate) mime_type: String,
}

/// TS: dashboard-space-contracts.ts:94 DashboardArtifactPage
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardArtifactPage {
    pub(crate) items: Vec<DashboardArtifact>,
    pub(crate) next_cursor: Option<String>,
}

/// TS: dashboard-space-contracts.ts:99 DashboardBriefingSource
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardBriefingSource {
    pub(crate) source_id: String,
    /// "work" | "plan" | "spec" | "report" | "message"
    pub(crate) kind: String,
    pub(crate) id: String,
    pub(crate) revision: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) session_id: Option<String>,
}

/// TS: dashboard-space-contracts.ts:110 DashboardBriefingContent (inline position).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardBriefingPosition {
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) source_ids: Vec<String>,
}

/// TS: dashboard-space-contracts.ts:111 DashboardBriefingContent (inline suggestion).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardBriefingSuggestion {
    pub(crate) candidate_id: String,
    pub(crate) title: String,
    pub(crate) reason: String,
    pub(crate) source_ids: Vec<String>,
}

/// TS: dashboard-space-contracts.ts:108 DashboardBriefingContent
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct DashboardBriefingContent {
    pub(crate) introduction: String,
    pub(crate) position: DashboardBriefingPosition,
    pub(crate) suggestions: Vec<DashboardBriefingSuggestion>,
}

/// TS: dashboard-space-contracts.ts:118 DashboardBriefingView (inline coverage).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardBriefingCoverage {
    pub(crate) total_works: i64,
    pub(crate) included_works: i64,
    pub(crate) included_documents: i64,
    pub(crate) included_reports: i64,
    pub(crate) excluded_units: i64,
}

/// TS: dashboard-space-contracts.ts:126 DashboardBriefingView (inline candidate).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardBriefingCandidate {
    pub(crate) id: String,
    pub(crate) source_id: String,
    pub(crate) text: String,
}

/// TS: dashboard-space-contracts.ts:114 DashboardBriefingView
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardBriefingView {
    /// "needed" | "generating" | "ready" | "unavailable"
    pub(crate) status: String,
    pub(crate) source_revision: String,
    pub(crate) language: String,
    pub(crate) coverage: DashboardBriefingCoverage,
    pub(crate) sources: Vec<DashboardBriefingSource>,
    pub(crate) candidates: Vec<DashboardBriefingCandidate>,
    #[serde(default)]
    pub(crate) content: Option<DashboardBriefingContent>,
    #[serde(default)]
    pub(crate) generated_at: Option<String>,
}

/// TS: dashboard-space-contracts.ts:156 DashboardStatisticSource
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardStatisticSource {
    pub(crate) title: String,
    pub(crate) at: String,
    #[serde(default)]
    pub(crate) source: Option<DashboardSourceRef>,
    #[serde(default)]
    pub(crate) session: Option<DashboardSessionRef>,
    #[serde(default)]
    pub(crate) duration_ms: Option<f64>,
}

/// TS: dashboard-space-contracts.ts:166 DashboardStatisticSeries (inline bucket).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct DashboardStatisticBucket {
    pub(crate) label: String,
    pub(crate) values: BTreeMap<String, Vec<String>>,
}

/// TS: dashboard-space-contracts.ts:164 DashboardStatisticSeries
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct DashboardStatisticSeries {
    pub(crate) keys: Vec<String>,
    pub(crate) buckets: Vec<DashboardStatisticBucket>,
}

/// TS: dashboard-space-contracts.ts:135 DashboardStatisticsView (inline day).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct DashboardStatisticDay {
    pub(crate) date: String,
    pub(crate) start: String,
    pub(crate) end: String,
    pub(crate) partial: bool,
}

/// TS: dashboard-space-contracts.ts:140 DashboardStatisticsView (inline work card).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardStatisticCard {
    #[serde(flatten)]
    pub(crate) card: DashboardBoardCard,
    pub(crate) source_key: String,
    pub(crate) age_days: Option<f64>,
}

/// TS: dashboard-space-contracts.ts:142 DashboardStatisticsView (inline work activity).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardStatisticActivity {
    pub(crate) source_key: String,
    pub(crate) dates: Vec<String>,
    pub(crate) changes: i64,
}

/// TS: dashboard-space-contracts.ts:137 DashboardStatisticsView (inline work).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct DashboardWorkStatistics {
    pub(crate) work: DashboardStatisticSeries,
    pub(crate) task: DashboardStatisticSeries,
    /// "work" | "task" → cards
    pub(crate) cards: BTreeMap<String, Vec<DashboardStatisticCard>>,
    pub(crate) excluded: i64,
    pub(crate) activity: Vec<DashboardStatisticActivity>,
}

/// TS: dashboard-space-contracts.ts:149 DashboardStatisticsView (inline execution).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct DashboardExecutionStatistics {
    pub(crate) outcomes: DashboardStatisticSeries,
    pub(crate) duration: DashboardStatisticSeries,
    pub(crate) excluded: i64,
}

/// TS: dashboard-space-contracts.ts:150 DashboardStatisticsView (inline usage).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct DashboardUsageStatistics {
    pub(crate) status: String,
    pub(crate) reason: String,
}

/// TS: dashboard-space-contracts.ts:131 DashboardStatisticsView
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardStatisticsView {
    pub(crate) timezone: String,
    /// 7 | 30 | 90
    pub(crate) period: i64,
    pub(crate) observed_at: String,
    pub(crate) days: Vec<DashboardStatisticDay>,
    pub(crate) sources: BTreeMap<String, DashboardStatisticSource>,
    pub(crate) work: Option<DashboardWorkStatistics>,
    pub(crate) activity: DashboardStatisticSeries,
    pub(crate) materials: DashboardStatisticSeries,
    pub(crate) material_types: DashboardStatisticSeries,
    pub(crate) ledger_history_available: bool,
    pub(crate) session_history_available: bool,
    pub(crate) execution: DashboardExecutionStatistics,
    pub(crate) usage: DashboardUsageStatistics,
}

/// TS: dashboard-space-contracts.ts:171 DashboardWorkCard
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardWorkCard {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) revision: Option<String>,
    /// "managed_work" | "ledger_record"
    pub(crate) authority_kind: String,
    /// "open" | "blocked" | "completed" | "abandoned" | "unknown"
    pub(crate) execution_status: String,
    pub(crate) ledger_status: String,
    pub(crate) updated_at: String,
    pub(crate) priority: i64,
    pub(crate) task_progress: Option<DashboardProgress>,
}

/// TS: dashboard-space-contracts.ts:184 DashboardOverview (the ready arm).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardOverviewReady {
    pub(crate) source_revision: String,
    pub(crate) observed_at: String,
    pub(crate) total_works: i64,
    /// execution status → count
    pub(crate) progress: BTreeMap<String, i64>,
    pub(crate) remaining: Vec<DashboardWorkCard>,
    pub(crate) remaining_count: i64,
}

/// TS: dashboard-space-contracts.ts:183 DashboardOverview
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum DashboardOverview {
    Ready(DashboardOverviewReady),
    /// "unbound" | "source_unavailable"
    Unavailable {
        reason: String,
    },
}

/// TS: dashboard-space-contracts.ts:195 DashboardBoardCard (inline session).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct DashboardBoardSession {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) running: bool,
}

/// TS: dashboard-space-contracts.ts:195 DashboardBoardCard
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardBoardCard {
    pub(crate) id: String,
    /// "work" | "plan" | "task"
    pub(crate) kind: String,
    pub(crate) title: String,
    pub(crate) parent_id: Option<String>,
    pub(crate) status: String,
    /// "planned" | "active" | "review" | "blocked" | "done" | "other"
    pub(crate) lane: String,
    pub(crate) updated_at: String,
    pub(crate) task_progress: Option<DashboardProgress>,
    pub(crate) action_progress: Option<DashboardProgress>,
    pub(crate) session: Option<DashboardBoardSession>,
}

/// TS: dashboard-space-contracts.ts:209 DashboardBoardPage (the ready arm).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardBoardReady {
    pub(crate) source_revision: String,
    pub(crate) items: Vec<DashboardBoardCard>,
    pub(crate) total: i64,
    pub(crate) next_cursor: Option<String>,
    /// lane → count
    pub(crate) lane_counts: BTreeMap<String, i64>,
    pub(crate) parents: Vec<DashboardSessionRef>,
}

/// TS: dashboard-space-contracts.ts:208 DashboardBoardPage
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum DashboardBoardPage {
    Ready(DashboardBoardReady),
    Unavailable { reason: String },
}

/// TS: dashboard-space-contracts.ts:221 ProjectDashboardActivityDay
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct ProjectDashboardActivityDay {
    pub(crate) date: String,
    pub(crate) count: i64,
}

/// TS: dashboard-space-contracts.ts:255 DashboardMaterialsPage (the ready arm).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardMaterialsReady {
    pub(crate) documents: Vec<ProjectDashboardDocument>,
    pub(crate) total: i64,
    pub(crate) next_cursor: Option<String>,
}

/// TS: dashboard-space-contracts.ts:254 DashboardMaterialsPage
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum DashboardMaterialsPage {
    Ready(DashboardMaterialsReady),
    Unavailable { reason: String },
}

/// TS: dashboard-space-contracts.ts:263 DashboardHistoryPage (inline event).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardHistoryEvent {
    pub(crate) id: String,
    pub(crate) at: String,
    /// "created" | "updated" | "completed" | "reported" | "reviewed" | "disposition" | "result"
    pub(crate) action: String,
    #[serde(default)]
    pub(crate) work_id: Option<String>,
    #[serde(default)]
    pub(crate) session: Option<DashboardSessionRef>,
    #[serde(default)]
    pub(crate) artifact_count: Option<i64>,
    pub(crate) title: String,
    pub(crate) source: DashboardSourceRef,
}

/// TS: dashboard-space-contracts.ts:259 DashboardHistoryPage (the ready arm).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardHistoryReady {
    pub(crate) next_cursor: Option<String>,
    #[serde(default)]
    pub(crate) ledger_unavailable: Option<bool>,
    pub(crate) events: Vec<DashboardHistoryEvent>,
}

/// TS: dashboard-space-contracts.ts:258 DashboardHistoryPage
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum DashboardHistoryPage {
    Ready(DashboardHistoryReady),
    Unavailable { reason: String },
}

/// TS: dashboard-space-contracts.ts:276 ProjectDashboardView (inline preferences).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectDashboardPreferences {
    pub(crate) revision: i64,
    pub(crate) pinned_source_refs: Vec<DashboardSourceRef>,
}

/// TS: dashboard-space-contracts.ts:279 ProjectDashboardView (inline stats).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub(crate) struct ProjectDashboardStats {
    pub(crate) active_sessions: i64,
    pub(crate) archived_sessions: i64,
    pub(crate) recent_messages_7d: i64,
    pub(crate) recent_messages_30d: i64,
    pub(crate) specs: i64,
    pub(crate) plans: i64,
}

/// TS: dashboard-space-contracts.ts:286 ProjectDashboardView (inline activity).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct ProjectDashboardActivity {
    pub(crate) days: Vec<ProjectDashboardActivityDay>,
}

/// TS: dashboard-space-contracts.ts:273 ProjectDashboardView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ProjectDashboardView {
    #[serde(default)]
    pub(crate) briefing: Option<DashboardBriefingView>,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) preferences: Option<ProjectDashboardPreferences>,
    #[serde(default)]
    pub(crate) overview: Option<DashboardOverview>,
    pub(crate) project: ProjectSummary,
    pub(crate) stats: ProjectDashboardStats,
    pub(crate) activity: ProjectDashboardActivity,
    #[serde(default)]
    pub(crate) documents: Vec<ProjectDashboardDocument>,
    pub(crate) generated_at: String,
}
