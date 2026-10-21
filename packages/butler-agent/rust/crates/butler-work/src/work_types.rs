//! Wire/storage identities and closed vocabulary. SQL uses these exact spellings.
use serde::{Deserialize, Serialize};
use std::str::FromStr;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown work-model enum value: {0}")]
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
ids!(
    PlanId,
    WorkId,
    TaskId,
    ChainId,
    SpecNodeId,
    InstructionId,
    AttemptId,
    ResultId,
    ReviewId,
    HoldId,
    HoldDecisionId,
    SessionId,
    OperationId
);

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
vocabulary!(RunState {
    Idle => "idle", Waiting => "waiting", Held => "held", Running => "running",
    InReview => "in_review", Blocked => "blocked", Failed => "failed", Paused => "paused",
    Stopped => "stopped", Done => "done", Cancelled => "cancelled"
});
vocabulary!(CanonStatus { Planned => "planned", InProgress => "in_progress",
    InReview => "in_review", Blocked => "blocked", Done => "done", Cancelled => "cancelled" });
vocabulary!(CanonStatusSource { Runtime => "runtime", Person => "person", Remote => "remote" });
vocabulary!(HoldReason { PredecessorFailed => "predecessor_failed", PredecessorStopped => "predecessor_stopped" });
vocabulary!(QueueOrigin { UserMessage => "user_message", Schedule => "schedule", Detach => "detach" });
vocabulary!(Origin { Chat => "chat", Dialog => "dialog", Board => "board", Github => "github", Mcp => "mcp", Migration => "migration" });
vocabulary!(Visibility { Private => "private", Canon => "canon" });
vocabulary!(ScopeKind { Session => "session", Project => "project" });
vocabulary!(ChainState { Active => "active", Held => "held", Done => "done" });
vocabulary!(Decision { RunAnyway => "run_anyway", Delete => "delete" });
vocabulary!(PlanStatus { Open => "open", Closed => "closed" });
vocabulary!(TaskStatus { Draft => "draft", Pending => "pending", Running => "running",
    AwaitingReview => "awaiting_review", Completed => "completed", Blocked => "blocked",
    Paused => "paused", Stopped => "stopped", Cancelled => "cancelled" });
vocabulary!(TaskKind { Execute => "execute", Integrate => "integrate", Review => "review" });
vocabulary!(AttemptStatus { Running => "running", Succeeded => "succeeded", Failed => "failed", Interrupted => "interrupted" });
vocabulary!(InstructionStatus { Accepted => "accepted", WaitingForTurn => "waiting_for_turn",
    WaitingForTask => "waiting_for_task", PendingSafePoint => "pending_safe_point",
    Delivered => "delivered", Applied => "applied", Rejected => "rejected", NeedsInput => "needs_input",
    Superseded => "superseded", Cancelled => "cancelled" });
vocabulary!(InstructionMode { Queue => "queue", Steer => "steer" });
vocabulary!(AnchorKind { Turn => "turn", Task => "task" });
vocabulary!(ExecutionPhase { Conception => "conception", Planning => "planning", Execution => "execution",
    Review => "review", Validation => "validation", Reporting => "reporting" });
vocabulary!(ControlState { Running => "running", Pausing => "pausing", Paused => "paused",
    Stopping => "stopping", Stopped => "stopped", Reconciling => "reconciling" });
vocabulary!(HoldKind { Pause => "pause", Stop => "stop" });
vocabulary!(IntentState { Pending => "pending", Applied => "applied" });
vocabulary!(SpecSource { Local => "local", Repo => "repo" });
vocabulary!(SpecState { Published => "published", Active => "active", Inactive => "inactive" });
// Lifecycle and migration states are storage vocabulary, not runtime transitions.
vocabulary!(SpecLifecycle { Draft => "draft", Active => "active", Retired => "retired" });
vocabulary!(MigrationState { Pending => "pending", Importing => "importing", NeedsSource => "needs_source", Complete => "complete" });
vocabulary!(ReviewVerdict { Accepted => "accepted", Rejected => "rejected" });
