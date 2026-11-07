//! Wire types for the P2 wave-2 `new_chat` unit (mirror TS, `/// TS: path:line`).
use serde::Deserialize;

/// TS: packages/butler-app/client/ui/src/app/types.ts:1583 NewChatBriefingSuggestion
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct NewChatSuggestion {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) text: String,
    /// A template the user finishes: it fills the composer instead of sending.
    #[serde(default)]
    pub(crate) template: bool,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1597 NewChatBriefingView.source (the
/// field the screen reads).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct NewChatBriefingSource {
    #[serde(default)]
    pub(crate) project_name: Option<String>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1592 NewChatBriefingView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct NewChatBriefing {
    pub(crate) moment: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    pub(crate) suggestions: Vec<NewChatSuggestion>,
    #[serde(default)]
    pub(crate) source: Option<NewChatBriefingSource>,
}
