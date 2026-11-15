//! The shell owns tab order and metadata; page engines report changes over a channel.
use std::fmt;

use futures::{StreamExt as _, channel::mpsc};
use gpui::{AnyElement, App, Global, SharedString, Window};

use super::address::{AddressError, address_url, web_url};
use super::engine::{PageChange, PageCommand, PageEngine, PageEvent, Profile, TabId};
use super::placeholder::PlaceholderEngine;

// Mirrors butler-runtime/src/browser/capacity.rs.
const USER_TABS: usize = 30;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Owner {
    Mine,
    Conversation(SharedString),
}

impl Owner {
    pub(crate) fn parse(value: &str) -> Result<Self, BrowserError> {
        if value == "mine" {
            return Ok(Self::Mine);
        }
        if let Some(id) = value.strip_prefix("conversation:")
            && (1..=128).contains(&id.len())
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        {
            return Ok(Self::Conversation(id.to_owned().into()));
        }
        Err(BrowserError::InvalidOwner)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TabStatus {
    Idle,
    Loading,
    Crashed,
}

#[derive(Clone)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent navigation capabilities and tab metadata flags"
)]
pub(crate) struct Tab {
    pub(crate) id: TabId,
    pub(crate) owner: Owner,
    pub(crate) epoch: u64,
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) favicon: String,
    pub(crate) status: TabStatus,
    pub(crate) can_back: bool,
    pub(crate) can_forward: bool,
    pub(crate) placeholder: bool,
    pub(crate) profile: Profile,
    pub(crate) opener: Option<TabId>,
    pub(crate) popup: bool,
    pub(crate) blocked_popup: Option<super::page_dialog::BlockedPopup>,
    pub(crate) dialog: Option<super::page_dialog::PageDialog>,
    pub(crate) picking: bool,
    pub(crate) selections: Vec<super::pick::Item>,
    pub(crate) pick_hover: Option<super::pick::Hover>,
    pub(crate) pick: super::pick::Session,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BrowserError {
    BrowsingDisabled,
    InvalidOwner,
    TabBudgetExhausted,
    BlockedProtocol,
    InvalidAddress,
    UnknownTab,
    InvalidMove,
}

impl fmt::Display for BrowserError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::BrowsingDisabled => "browsing_disabled",
            Self::InvalidOwner => "invalid_owner",
            Self::TabBudgetExhausted => "tab_budget_exhausted",
            Self::BlockedProtocol => "blocked_protocol",
            Self::InvalidAddress => "invalid_address",
            Self::UnknownTab => "unknown_tab",
            Self::InvalidMove => "invalid_move",
        })
    }
}

impl std::error::Error for BrowserError {}

impl From<AddressError> for BrowserError {
    fn from(error: AddressError) -> Self {
        match error {
            AddressError::Invalid => Self::InvalidAddress,
            AddressError::BlockedProtocol => Self::BlockedProtocol,
        }
    }
}

pub(crate) struct BrowserState {
    pub(super) engine: Box<dyn PageEngine>,
    pub(super) tabs: Vec<Tab>,
    pub(super) active: Option<TabId>,
    pub(super) next_id: u64,
    pub(super) publisher: super::host::Publisher,
}

impl Global for BrowserState {}

impl BrowserState {
    pub(crate) fn init(cx: &mut App) {
        let (sender, mut receiver) = mpsc::unbounded();
        let engine = Self::engine(sender, cx);
        let publisher = super::host::Publisher::start(cx);
        cx.set_global(Self {
            publisher,
            engine,
            tabs: Vec::new(),
            active: None,
            next_id: 0,
        });
        cx.spawn(async move |cx| {
            while let Some(event) = receiver.next().await {
                cx.update(|cx| {
                    super::pick::navigation(&event, cx);
                    cx.global_mut::<Self>().apply(event);
                    super::popup_window::sync(cx);
                    cx.refresh_windows();
                });
            }
        })
        .detach();
    }

    fn engine(sender: mpsc::UnboundedSender<PageEvent>, cx: &mut App) -> Box<dyn PageEngine> {
        #[cfg(feature = "cef")]
        match super::cef::CefEngine::start(sender.clone(), cx) {
            Ok(engine) => return Box::new(engine),
            Err(error) => eprintln!("CEF unavailable: {error}"),
        }
        let _ = cx;
        Box::new(PlaceholderEngine::new(sender))
    }

    pub(crate) fn show(&mut self, id: Option<&TabId>) {
        self.engine.show(id);
    }
    pub(crate) fn frame_size(&self, id: &TabId) -> Option<(usize, usize)> {
        self.engine.frame_size(id)
    }

    pub(crate) fn create(
        &mut self,
        owner: Owner,
        url: Option<&str>,
        placeholder: bool,
    ) -> Result<Option<TabId>, BrowserError> {
        if !self.enabled() {
            return Err(BrowserError::BrowsingDisabled);
        }
        let url = url.filter(|url| !url.is_empty());
        if placeholder && url.is_none() && self.tabs.iter().any(|tab| tab.owner == owner) {
            return Ok(None);
        }
        let url = url
            .map(|url| web_url(url).ok_or(BrowserError::BlockedProtocol))
            .transpose()?
            .unwrap_or_default();
        if self.tabs.iter().filter(|tab| tab.owner == owner).count() >= USER_TABS {
            return Err(BrowserError::TabBudgetExhausted);
        }
        self.next_id += 1;
        let id = TabId(format!("t{}", self.next_id).into());
        let tab_owner = owner.clone();
        let profile = Profile::for_url(&url);
        self.tabs.push(Tab {
            id: id.clone(),
            owner,
            epoch: 1,
            profile,
            placeholder: placeholder && url.is_empty(),
            url: url.clone(),
            title: String::new(),
            favicon: String::new(),
            status: TabStatus::Idle,
            can_back: false,
            can_forward: false,
            opener: None,
            popup: false,
            blocked_popup: None,
            dialog: None,
            picking: false,
            selections: Vec::new(),
            pick_hover: None,
            pick: Default::default(),
        });
        self.activate(&id);
        if !url.is_empty() {
            self.drop_placeholders(&tab_owner);
        }
        self.engine
            .open(&id, &url, profile, &super::area::owner_key(&tab_owner));
        self.publisher.changed(&self.tabs);
        Ok(Some(id))
    }

    pub(crate) fn activate(&mut self, id: &TabId) {
        if self.tab(id).is_some() {
            self.active = Some(id.clone());
        }
    }

    pub(crate) fn close(&mut self, id: &TabId) {
        self.close_popups(id);
        self.cancel_dialog(id, "tab_closed");
        let Some(index) = self.tabs.iter().position(|tab| &tab.id == id) else {
            return;
        };
        self.engine.close(id);
        self.tabs.remove(index);
        self.publisher.changed(&self.tabs);
        if self.active.as_ref() == Some(id) {
            self.active = self.tabs.last().map(|tab| tab.id.clone());
        }
    }

    fn drop_placeholders(&mut self, owner: &Owner) {
        let ids: Vec<_> = self
            .tabs
            .iter()
            .filter(|tab| tab.placeholder && &tab.owner == owner && tab.url.is_empty())
            .map(|tab| tab.id.clone())
            .collect();
        for id in ids {
            if self.active.as_ref() == Some(&id) {
                self.active = None;
            }
            self.close(&id);
        }
    }

    pub(crate) fn move_tab(
        &mut self,
        id: &TabId,
        to: Owner,
        index: isize,
    ) -> Result<(), BrowserError> {
        let from = self
            .tabs
            .iter()
            .position(|tab| &tab.id == id)
            .ok_or(BrowserError::InvalidMove)?;
        let changed_owner = self.tabs[from].owner != to;
        if changed_owner
            && to == Owner::Mine
            && self.tabs.iter().filter(|tab| tab.owner == to).count() >= USER_TABS
        {
            return Err(BrowserError::TabBudgetExhausted);
        }
        if changed_owner {
            self.close_popups(id);
            self.cancel_dialog(id, "owner_changed");
            self.engine.change_owner(id, &super::area::owner_key(&to));
        }
        let from = self
            .tabs
            .iter()
            .position(|tab| &tab.id == id)
            .ok_or(BrowserError::InvalidMove)?;
        let mut tab = self.tabs.remove(from);
        let new_owner = to.clone();
        tab.owner = to;
        if changed_owner {
            tab.epoch += 1;
        }
        let before = self
            .tabs
            .iter()
            .enumerate()
            .filter(|(_, tab)| tab.owner == new_owner)
            .nth(usize::try_from(index).unwrap_or(0))
            .map(|(i, _)| i)
            .unwrap_or(self.tabs.len());
        let has_url = !tab.url.is_empty();
        self.tabs.insert(before, tab);
        if changed_owner && has_url {
            self.drop_placeholders(&new_owner);
        }
        self.publisher.changed(&self.tabs);
        Ok(())
    }

    pub(crate) fn navigate(&mut self, id: &TabId, input: &str) -> Result<(), BrowserError> {
        self.command_allowed(id)?;
        let Some(url) = address_url(input)? else {
            return Ok(());
        };
        if let Some(tab) = self.tabs.iter_mut().find(|tab| &tab.id == id) {
            tab.placeholder = false;
        }
        self.engine.command(id, PageCommand::Load(url));
        Ok(())
    }

    fn command_allowed(&self, id: &TabId) -> Result<(), BrowserError> {
        if self.tab(id).is_none() {
            return Err(BrowserError::UnknownTab);
        }
        if !self.enabled() {
            return Err(BrowserError::BrowsingDisabled);
        }
        Ok(())
    }

    pub(crate) fn back(&mut self, id: &TabId) -> Result<(), BrowserError> {
        self.command_allowed(id)?;
        if self.tab(id).is_some_and(|tab| tab.can_back) {
            self.engine.command(id, PageCommand::Back);
        }
        Ok(())
    }

    pub(crate) fn forward(&mut self, id: &TabId) -> Result<(), BrowserError> {
        self.command_allowed(id)?;
        if self.tab(id).is_some_and(|tab| tab.can_forward) {
            self.engine.command(id, PageCommand::Forward);
        }
        Ok(())
    }

    pub(crate) fn reload(&mut self, id: &TabId) -> Result<(), BrowserError> {
        self.command_allowed(id)?;
        self.engine.command(id, PageCommand::Reload);
        Ok(())
    }

    pub(crate) fn stop(&mut self, id: &TabId) -> Result<(), BrowserError> {
        self.command_allowed(id)?;
        self.engine.command(id, PageCommand::Stop);
        Ok(())
    }

    pub(crate) fn resize(&mut self, id: &TabId, size: gpui::Size<gpui::Pixels>, scale: f32) {
        if let Some(tab) = self.tab(id) {
            tab.pick.viewport.set((
                f64::from(f32::from(size.width)),
                f64::from(f32::from(size.height)),
            ));
            self.engine.resize(id, size, scale);
        }
    }

    pub(crate) fn apply(&mut self, event: PageEvent) {
        #[cfg(feature = "cef")]
        if self.popup_event(&event) {
            self.publisher.changed(&self.tabs);
            return;
        }
        let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == event.page) else {
            return;
        };
        match event.change {
            PageChange::DevToolsEvent { .. } => {}
            PageChange::Url(url) => tab.url = url,
            PageChange::Title(title) => tab.title = title,
            PageChange::Favicon(favicon) => tab.favicon = favicon,
            PageChange::Loading(true) => tab.status = TabStatus::Loading,
            PageChange::Loading(false) if tab.status != TabStatus::Crashed => {
                tab.status = TabStatus::Idle;
            }
            PageChange::Loading(false) => {}
            PageChange::History {
                can_back,
                can_forward,
            } => {
                tab.can_back = can_back;
                tab.can_forward = can_forward;
            }
            PageChange::Crashed => tab.status = TabStatus::Crashed,
            #[cfg(feature = "cef")]
            PageChange::Dialog(dialog) => tab.dialog = Some(dialog),
            #[cfg(feature = "cef")]
            PageChange::PopupNewTab(_)
            | PageChange::PopupBlocked { .. }
            | PageChange::PopupOpened { .. }
            | PageChange::CloseRequested => {}
        }
        self.publisher.changed(&self.tabs);
    }

    pub(crate) fn tabs(&self) -> &[Tab] {
        &self.tabs
    }
    pub(crate) fn active(&self) -> Option<&TabId> {
        self.active.as_ref()
    }
    pub(crate) fn tab(&self, id: &TabId) -> Option<&Tab> {
        self.tabs.iter().find(|tab| &tab.id == id)
    }
    pub(crate) fn enabled(&self) -> bool {
        self.engine.enabled()
    }
    pub(crate) fn surface(
        &self,
        id: &TabId,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement> {
        self.engine.surface(id, window, cx)
    }
}
