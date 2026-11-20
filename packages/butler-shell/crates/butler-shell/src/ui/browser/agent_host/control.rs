//! Who holds a hosted page (Electron `controlTab`): the user takes it by selecting a page the
//! Agent waits on or by using a page the Agent is not acting in, and gives it back by leaving it.
use super::{Holder, Hosted};
use crate::ui::browser::{
    engine::TabId,
    model::{BrowserError, BrowserState, Tab},
};
use serde_json::Value;

/// The human step the Agent stopped at, with its reason.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    SignIn(String),
    Pay(String),
}
impl Step {
    /// `{"kind":"signin"|"pay","reason":"…"}`; anything else, null included, is no step.
    pub(super) fn parse(value: &Value) -> Option<Self> {
        let reason = value["reason"].as_str()?.to_owned();
        match value["kind"].as_str()? {
            "signin" => Some(Self::SignIn(reason)),
            "pay" => Some(Self::Pay(reason)),
            _ => None,
        }
    }
}

/// The holder the page shows (Electron `browserHolder`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShownHolder {
    None,
    Butler,
    User,
    Waiting,
}

/// You hold the page: shown only while a Butler turn is paused on it, not for your own browsing.
pub(crate) fn shown_holder(tab: &Tab) -> ShownHolder {
    let Some(hosted) = tab.hosted.as_ref().filter(|hosted| !hosted.internal) else {
        return ShownHolder::None;
    };
    if tab.url.is_empty() {
        ShownHolder::None
    } else if hosted.waiting {
        ShownHolder::Waiting
    } else if hosted.holder == Holder::User {
        if hosted.paused {
            ShownHolder::User
        } else {
            ShownHolder::None
        }
    } else if hosted.in_use() {
        ShownHolder::Butler
    } else {
        ShownHolder::None
    }
}

/// Real input on a page: a mouse-down, key-down or IME text is a press; the rest only follows.
#[cfg(feature = "cef")]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(in crate::ui::browser) enum Input {
    MouseDown,
    KeyPress,
    Other,
}

#[cfg(feature = "cef")]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(in crate::ui::browser) enum Gate {
    Forward,
    Block,
}

impl BrowserState {
    /// Electron `controlTab`: nothing for a page the Agent does not host or an internal one.
    pub(crate) fn control(&mut self, id: &TabId, holder: Holder, sticky: bool) {
        self.set_holder(id, holder, sticky);
        self.publisher.changed(&self.tabs);
    }

    /// [`Self::control`] without publishing the snapshot.
    pub(super) fn set_holder(&mut self, id: &TabId, holder: Holder, sticky: bool) {
        if (self.tab(id))
            .and_then(|tab| tab.hosted.as_ref())
            .is_none_or(|hosted| hosted.internal)
        {
            return;
        }
        self.cancel_dialog(id, "control_changed");
        let Some(tab) = self.tabs.iter_mut().find(|tab| &tab.id == id) else {
            return;
        };
        let Some(hosted) = tab.hosted.as_mut() else {
            return;
        };
        match holder {
            // Electron `pauseHold`: only the turns holding the page pause it.
            Holder::User if hosted.holder == Holder::Agent => {
                hosted.paused = !hosted.turns.is_empty();
            }
            Holder::User => {}
            Holder::Agent => {
                if hosted.holder == Holder::User {
                    // The turns the user paused no longer hold the page (Electron `releaseHold`).
                    hosted.turns.clear();
                }
                hosted.paused = false;
                hosted.step = None;
            }
        }
        hosted.holder = holder;
        hosted.sticky = sticky;
        // The page dialog was cancelled above.
        hosted.waiting = false;
        tab.epoch += 1;
        // The CEF gate's hosted flag is this holder: popups follow whoever holds the page.
        self.engine.set_hosted(id, holder == Holder::Agent);
    }

    /// Selecting `id`, the active tab included: the page left returns to the Agent unless the
    /// user pinned it; a page the Agent waits on passes to the user.
    pub(in crate::ui::browser) fn hand_over(&mut self, id: &TabId) {
        if let Some(left) = self.active.clone().filter(|left| left != id)
            && (self.tab(&left).and_then(|tab| tab.hosted.as_ref()))
                .is_some_and(|hosted| hosted.holder == Holder::User && !hosted.sticky)
        {
            self.control(&left, Holder::Agent, false);
        }
        let waits = self.tab(id).is_some_and(|tab| {
            tab.dialog.is_none()
                && (tab.hosted.as_ref())
                    .is_some_and(|hosted| hosted.waiting && hosted.holder != Holder::User)
        });
        if waits {
            self.control(id, Holder::User, false);
        }
    }

    /// The active tab closed: the last tab becomes active through the same hand-over as a
    /// selection.
    pub(in crate::ui::browser) fn reselect(&mut self, closed: &TabId) {
        if self.active.as_ref() != Some(closed) {
            return;
        }
        self.active = None;
        if let Some(next) = self.tabs.last().map(|tab| tab.id.clone()) {
            self.activate(&next);
        }
    }

    /// The browser area stopped being shown (Electron `hide`): a page with an open dialog
    /// waits, and every page the user holds without pinning it returns to the Agent. Only the
    /// change from shown runs it.
    pub(crate) fn hide(&mut self) {
        self.engine.show(None);
        if !std::mem::take(&mut self.area_shown) {
            return;
        }
        for tab in &mut self.tabs {
            if tab.dialog.is_some()
                && let Some(hosted) = tab.hosted.as_mut()
            {
                hosted.waiting = true;
            }
        }
        self.release_unpinned();
        self.publisher.changed(&self.tabs);
    }

    /// Every page the user holds without pinning it returns to the Agent.
    pub(crate) fn release_unpinned(&mut self) {
        let held: Vec<_> = (self.tabs.iter())
            .filter(|tab| {
                (tab.hosted.as_ref())
                    .is_some_and(|hosted| hosted.holder == Holder::User && !hosted.sticky)
            })
            .map(|tab| tab.id.clone())
            .collect();
        for id in held {
            self.control(&id, Holder::Agent, false);
        }
    }

    /// A user command on a page the Agent is acting in is refused (Electron `tabs.mjs:290`).
    pub(in crate::ui::browser) fn agent_gate(&self, id: &TabId) -> Result<(), BrowserError> {
        let acting = (self.tab(id))
            .and_then(|tab| tab.hosted.as_ref())
            .is_some_and(Hosted::in_use);
        if acting {
            Err(BrowserError::AgentControl)
        } else {
            Ok(())
        }
    }

    /// Real input on `id`'s page: a mouse press takes over even while the Agent uses it.
    /// Other input is blocked while in use; otherwise a key press also takes over.
    #[cfg(feature = "cef")]
    pub(in crate::ui::browser) fn user_input(&mut self, id: &TabId, input: Input) -> Gate {
        let Some(hosted) = self.tab(id).and_then(|tab| tab.hosted.as_ref()) else {
            return Gate::Forward;
        };
        if hosted.holder == Holder::User {
            return Gate::Forward;
        }
        if hosted.in_use() && input != Input::MouseDown {
            return Gate::Block;
        }
        if matches!(input, Input::MouseDown | Input::KeyPress) {
            self.control(id, Holder::User, false);
        }
        Gate::Forward
    }
}
