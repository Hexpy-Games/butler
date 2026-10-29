//! Wire/storage identities and closed vocabulary. SQL uses these exact spellings.
use serde::{Deserialize, Serialize};
use std::str::FromStr;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown canon enum value: {0}")]
pub struct ParseError(pub String);

macro_rules! ids {
    ($($name:ident),+ $(,)?) => {$(
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);
        impl $name {
            #[must_use]
            pub fn as_str(&self) -> &str { &self.0 }
        }
    )+};
}
ids!(PlanId, WorkId, TaskId, SpecNodeId, SessionId, OperationId);
/// Canon chains use epic identities; retain the existing chain wire representation.
pub use TaskId as EpicId;

macro_rules! vocabulary {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        pub enum $name { $(#[serde(rename = $text)] $variant),+ }
        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];
            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }
        }
        impl FromStr for $name {
            type Err = ParseError;
            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value { $($text => Ok(Self::$variant),)+ _ => Err(ParseError(value.into())) }
            }
        }
    };
}

vocabulary!(CanonStatus { Planned => "planned", InProgress => "in_progress",
    InReview => "in_review", Blocked => "blocked", Done => "done", Cancelled => "cancelled" });
vocabulary!(CanonStatusSource { Runtime => "runtime", Person => "person" });

vocabulary!(Origin { Chat => "chat", Dialog => "dialog", Board => "board", Mcp => "mcp" });
vocabulary!(Visibility { Private => "private", Canon => "canon" });
vocabulary!(ScopeKind { Session => "session", Project => "project" });

vocabulary!(PlanStatus { Open => "open", Closed => "closed" });

vocabulary!(IntentState { Pending => "pending", Applied => "applied" });
vocabulary!(SpecSource { Local => "local", Repo => "repo" });
vocabulary!(SpecState { Published => "published", Active => "active", Inactive => "inactive" });
// Lifecycle and migration states are storage vocabulary, not runtime transitions.
vocabulary!(SpecLifecycle { Draft => "draft", Active => "active", Retired => "retired" });
