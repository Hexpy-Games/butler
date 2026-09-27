//! Lifecycle statuses of Work, Task and Attempt records and the moves the
//! Ledger allows between them. Records store statuses as snake_case text.

/// A record kind whose status follows a lifecycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Lifecycle {
    Work,
    Task,
    Attempt,
}

/// Every lifecycle status of any kind; [`Lifecycle::states`] says which
/// belong to which kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Status {
    Proposed,
    Scoped,
    Specified,
    InProgress,
    Review,
    Done,
    Blocked,
    Cancelled,
    Todo,
    Failed,
    Started,
    Succeeded,
    Interrupted,
}

use Status::{
    Blocked, Cancelled, Done, Failed, InProgress, Interrupted, Proposed, Review, Scoped, Specified,
    Started, Succeeded, Todo,
};

const WORK: &[Status] = &[
    Proposed, Scoped, Specified, InProgress, Review, Done, Blocked, Cancelled,
];
const TASK: &[Status] = &[Todo, InProgress, Done, Blocked, Failed, Cancelled];
const ATTEMPT: &[Status] = &[Started, Succeeded, Failed, Interrupted];

impl Lifecycle {
    pub(crate) fn parse(kind: &str) -> Option<Self> {
        match kind {
            "work" => Some(Self::Work),
            "task" => Some(Self::Task),
            "attempt" => Some(Self::Attempt),
            _ => None,
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Work => "work",
            Self::Task => "task",
            Self::Attempt => "attempt",
        }
    }

    /// The kind's statuses, in the order hints list them.
    pub(crate) fn states(self) -> &'static [Status] {
        match self {
            Self::Work => WORK,
            Self::Task => TASK,
            Self::Attempt => ATTEMPT,
        }
    }

    /// The kind's status named `text`, if it is one.
    pub(crate) fn status(self, text: &str) -> Option<Status> {
        self.states()
            .iter()
            .copied()
            .find(|status| status.as_str() == text)
    }

    /// Statuses a Ledger command may move a record to directly from `from`.
    pub(crate) fn transitions(self, from: Status) -> &'static [Status] {
        match (self, from) {
            (Self::Work, Proposed) => &[Scoped, Blocked, Cancelled],
            (Self::Work, Scoped) => &[Specified, InProgress, Blocked, Cancelled],
            (Self::Work, Specified) => &[InProgress, Review, Blocked, Cancelled],
            (Self::Work, InProgress) => &[Review, Blocked, Cancelled],
            (Self::Work, Review) => &[Done, InProgress, Blocked, Cancelled],
            (Self::Work, Blocked) | (Self::Task, Blocked | Failed) => &[InProgress, Cancelled],
            (Self::Task, Todo) => &[InProgress, Blocked, Cancelled],
            (Self::Task, InProgress) => &[Done, Failed, Blocked, Cancelled],
            (Self::Attempt, Started) => &[Succeeded, Failed, Interrupted],
            _ => &[],
        }
    }
}

impl Status {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Proposed => "proposed",
            Scoped => "scoped",
            Specified => "specified",
            InProgress => "in_progress",
            Review => "review",
            Done => "done",
            Blocked => "blocked",
            Cancelled => "cancelled",
            Todo => "todo",
            Failed => "failed",
            Started => "started",
            Succeeded => "succeeded",
            Interrupted => "interrupted",
        }
    }

    /// Whether Project Work publication may move a Work from `self` to
    /// `to`. Publication applies whole BTCC operations, so it may skip
    /// forward past intermediate statuses the commands walk one by one.
    pub(crate) fn publishes_to(self, to: Self) -> bool {
        if self == to {
            return true;
        }
        match self {
            Proposed => to != Proposed,
            Scoped => !matches!(to, Proposed | Scoped),
            Specified => !matches!(to, Proposed | Scoped | Specified),
            InProgress => matches!(to, Review | Done | Blocked | Cancelled),
            Review => matches!(to, Done | InProgress | Blocked | Cancelled),
            Blocked => matches!(to, InProgress | Review | Done | Cancelled),
            _ => false,
        }
    }
}
