//! Wire types for the P2 wave-2 `question_answer` unit (mirror TS, `/// TS: path:line`).
use serde::{Deserialize, Serialize};

/// TS: packages/butler-app/client/ui/src/app/types.ts:2054 UserQuestionResponse (request body of
/// `POST /authority-requests/{ref}/answer`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum QuestionAnswerBody {
    Answered { answers: Vec<QuestionAnswerWire> },
    Deferred {},
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:2053 UserQuestionAnswer
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct QuestionAnswerWire {
    pub(crate) id: String,
    pub(crate) selected: Vec<String>,
    pub(crate) custom: Option<String>,
    pub(crate) skipped: bool,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts AuthorityDecisionTransportView (the fields
/// `useComposerQuestion` checks).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct QuestionAnswerReply {
    pub(crate) request_ref: String,
    pub(crate) decision: String,
    #[serde(default)]
    pub(crate) scheduled: Option<bool>,
}
