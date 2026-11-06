//! Typed renderer wire contracts; field names follow their TypeScript sources.
use serde::Deserialize;

/// TS: packages/butler-app/client/ui/src/app/types.ts:1944 AuthorityRequestsTransportView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AuthorityRequestsTransportView {
    #[serde(default)]
    pub(crate) session_id: Option<serde_json::Value>,
    #[serde(default)]
    pub(crate) requests: Option<serde_json::Value>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1950 AuthorityDecisionTransportView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AuthorityDecisionTransportView {
    #[serde(default)]
    pub(crate) request_ref: Option<serde_json::Value>,
    #[serde(default)]
    pub(crate) decision: Option<serde_json::Value>,
    #[serde(default)]
    pub(crate) scheduled: Option<serde_json::Value>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:2054 UserQuestionResponse
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "status")]
pub(crate) enum UserQuestionResponse {
    #[serde(rename = "answered")]
    Answered {
        #[serde(default)]
        answers: Vec<UserQuestionAnswer>,
    },
    #[serde(rename = "deferred")]
    Deferred {},
}

/// TS: packages/butler-app/client/shared/pending-asks-contracts.ts:20 PendingAsk (inline GlobalPendingAsksAsksItemActionsItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum GlobalPendingAsksAsksItemActionsItem {
    #[serde(rename = "open")]
    Open,
    #[serde(rename = "allow")]
    Allow,
    #[serde(rename = "deny")]
    Deny,
    #[serde(rename = "answer")]
    Answer,
    #[serde(rename = "accept")]
    Accept,
    #[serde(rename = "decline")]
    Decline,
    #[serde(rename = "dismiss")]
    Dismiss,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/pending-asks-contracts.ts:28 GlobalPendingAsks (inline GlobalPendingAsksAsksItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct GlobalPendingAsksAsksItem {
    pub(crate) ask_id: String,
    pub(crate) kind: PendingAskKind,
    pub(crate) session_id: String,
    pub(crate) source_session_id: String,
    pub(crate) source_turn_id: String,
    #[serde(default)]
    pub(crate) source_message_id: Option<String>,
    #[serde(default)]
    pub(crate) source_call_id: Option<String>,
    pub(crate) deferred: bool,
    pub(crate) waiting_since: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) summary: Option<String>,
    #[serde(default)]
    pub(crate) target_label: Option<String>,
    pub(crate) blocking: bool,
    pub(crate) state: String,
    pub(crate) created_at: String,
    #[serde(default)]
    pub(crate) actions: Vec<GlobalPendingAsksAsksItemActionsItem>,
    pub(crate) session_title: String,
}

/// TS: packages/butler-app/client/shared/pending-asks-contracts.ts:27 GlobalPendingAsks
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct GlobalPendingAsks {
    #[serde(default)]
    pub(crate) asks: Vec<GlobalPendingAsksAsksItem>,
    #[serde(default)]
    pub(crate) next_cursor: Option<String>,
}

/// TS: packages/butler-app/client/shared/pending-asks-contracts.ts:22 SessionPendingAsks
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionPendingAsks {
    pub(crate) session_id: String,
    pub(crate) open_count: i64,
    #[serde(default)]
    pub(crate) asks: Vec<PendingAsk>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:2053 UserQuestionAnswer
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct UserQuestionAnswer {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) selected: Vec<String>,
    #[serde(default)]
    pub(crate) custom: Option<String>,
    pub(crate) skipped: bool,
}

/// TS: packages/butler-app/client/shared/pending-asks-contracts.ts:4 PendingAsk
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct PendingAsk {
    pub(crate) ask_id: String,
    pub(crate) kind: PendingAskKind,
    pub(crate) session_id: String,
    pub(crate) source_session_id: String,
    pub(crate) source_turn_id: String,
    #[serde(default)]
    pub(crate) source_message_id: Option<String>,
    #[serde(default)]
    pub(crate) source_call_id: Option<String>,
    pub(crate) deferred: bool,
    pub(crate) waiting_since: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) summary: Option<String>,
    #[serde(default)]
    pub(crate) target_label: Option<String>,
    pub(crate) blocking: bool,
    pub(crate) state: String,
    pub(crate) created_at: String,
    #[serde(default)]
    pub(crate) actions: Vec<GlobalPendingAsksAsksItemActionsItem>,
}

/// TS: packages/butler-app/client/shared/pending-asks-contracts.ts:2 PendingAskKind
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PendingAskKind {
    #[serde(rename = "approval")]
    Approval,
    #[serde(rename = "question")]
    Question,
    #[serde(rename = "canon_proposal")]
    CanonProposal,
    #[serde(other)]
    Unknown,
}
