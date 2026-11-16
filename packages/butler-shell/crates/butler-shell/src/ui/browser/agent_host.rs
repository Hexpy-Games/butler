//! The page host: the Agent runs the browser tools, the shell owns CEF pages and relays their
//! raw DevTools messages.
mod channel;
mod pages;
mod relay;

use gpui::App;

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

/// What makes a tab a hosted page: the Agent opened it and drives it over raw DevTools.
#[derive(Clone)]
pub(crate) struct Hosted {
    pub(super) target: String,
    pub(super) holder: Holder,
    pub(super) sticky: bool,
    pub(super) waiting: bool,
    pub(super) uses: u32,
    pub(super) internal: bool,
    /// The size the pane last asked for; applied when the page stops being hosted.
    pub(super) pane: Option<(gpui::Size<gpui::Pixels>, f32)>,
}
impl Hosted {
    /// The Agent is acting in the page right now.
    pub(super) fn driven(&self) -> bool {
        self.holder == Holder::Agent && self.uses > 0
    }
    pub(super) fn agent(internal: bool) -> Self {
        Self {
            target: String::new(),
            holder: Holder::Agent,
            sticky: false,
            waiting: false,
            uses: 0,
            internal,
            pane: None,
        }
    }
}

pub(super) fn start(cx: &mut App) {
    relay::start(cx);
    channel::start(cx);
}
