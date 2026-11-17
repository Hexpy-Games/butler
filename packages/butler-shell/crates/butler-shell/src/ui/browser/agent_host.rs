//! The page host: the Agent runs the browser tools, the shell owns CEF pages and relays their
//! raw DevTools messages.
mod channel;
mod control;
mod pages;
mod relay;

use gpui::App;

pub(crate) use control::Step;
#[cfg(feature = "cef")]
pub(super) use control::{Gate, Input};
#[allow(
    unused_imports,
    reason = "the browser band reads it in the next change"
)]
pub(crate) use control::{ShownHolder, shown_holder};
pub(super) use relay::{closed, page_changed};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Holder {
    Agent,
    User,
}
impl Holder {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::User => "user",
        }
    }
}

/// Where a hosted page is in its first use.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Stage {
    /// Just opened and not yet used: the page stays awake until its opening call ends.
    Opening,
    Open,
}

/// What makes a tab a hosted page: the Agent opened it and drives it over raw DevTools.
#[derive(Clone)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent hold flags the snapshot publishes"
)]
pub(crate) struct Hosted {
    pub(super) target: String,
    pub(super) holder: Holder,
    pub(super) sticky: bool,
    pub(super) waiting: bool,
    pub(super) uses: u32,
    /// The turns holding the page: each holds it from its first use until it finishes.
    pub(super) turns: Vec<String>,
    /// The user took the page over while the Agent was using it.
    pub(super) paused: bool,
    /// The human step the Agent stopped at.
    pub(super) step: Option<Step>,
    /// The turn waiting on the user here; its end clears the wait and the step.
    pub(super) waiting_turn: Option<String>,
    pub(super) stage: Stage,
    pub(super) internal: bool,
    /// The size the pane last asked for; applied when the page stops being hosted.
    pub(super) pane: Option<(gpui::Size<gpui::Pixels>, f32)>,
    /// The id of the Agent's `Runtime.runIfWaitingForDebugger` on the page until its reply: the
    /// Agent letting the page run.
    pub(super) start: Option<serde_json::Value>,
}
impl Hosted {
    /// The Agent holds the page and a call or a turn of it is using the page.
    pub(crate) fn in_use(&self) -> bool {
        self.holder == Holder::Agent && (self.uses > 0 || !self.turns.is_empty())
    }
    /// The Agent is acting in the page right now.
    pub(crate) fn busy(&self) -> bool {
        self.holder == Holder::Agent && self.uses > 0
    }
    pub(crate) fn signin_step(&self) -> Option<&str> {
        match &self.step {
            Some(Step::SignIn(reason)) => Some(reason),
            _ => None,
        }
    }
    pub(crate) fn pay_step(&self) -> Option<&str> {
        match &self.step {
            Some(Step::Pay(reason)) => Some(reason),
            _ => None,
        }
    }
    /// Whether the page must stay awake (not throttled as hidden): just opened, or in use.
    pub(super) fn awake(&self) -> bool {
        self.stage == Stage::Opening || self.uses > 0
    }
    /// The Agent holds the page: its popups follow the Agent's rule, not the user's.
    pub(super) fn held_by_agent(&self) -> bool {
        self.holder == Holder::Agent
    }
    pub(super) fn agent(internal: bool) -> Self {
        Self {
            target: String::new(),
            holder: Holder::Agent,
            sticky: false,
            waiting: false,
            uses: 0,
            turns: Vec::new(),
            paused: false,
            step: None,
            waiting_turn: None,
            stage: Stage::Opening,
            internal,
            pane: None,
            start: None,
        }
    }
}

pub(super) fn start(cx: &mut App) {
    relay::start(cx);
    channel::start(cx);
}
