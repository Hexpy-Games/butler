use super::{engine::TabId, model::BrowserState, page_dialog::DialogAnswer};
#[cfg(feature = "cef")]
use super::{
    engine::{PageChange, PageEvent},
    model::{Tab, TabStatus},
    page_dialog::{BlockedPopup, EngineChild},
};

#[cfg(feature = "cef")]
pub(super) fn site(url: &str) -> String {
    url::Url::parse(url)
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_default()
}
impl BrowserState {
    pub(crate) fn allow_popup(&mut self, id: &TabId) {
        let Some(blocked) = self
            .tabs
            .iter_mut()
            .find(|t| &t.id == id)
            .and_then(|t| t.blocked_popup.take())
        else {
            return;
        };
        if blocked.reason == "no_gesture" {
            self.engine.allow_popup(id, &blocked.url);
        }
    }
    pub(crate) fn answer_dialog(&mut self, id: &TabId, dialog: u64, answer: DialogAnswer) {
        if let Some(embed) = self.embeds.get_mut(id) {
            if embed.dialog.as_ref().is_some_and(|d| d.id == dialog) {
                embed.dialog = None;
                self.engine.answer_dialog(id, dialog, answer);
            }
            return;
        }
        let Some(tab) = self.tabs.iter_mut().find(|t| &t.id == id) else {
            return;
        };
        if tab.dialog.as_ref().is_some_and(|d| d.id == dialog) {
            tab.dialog = None;
            self.engine.answer_dialog(id, dialog, answer);
        }
    }
    pub(super) fn cancel_dialog(&mut self, id: &TabId, _reason: &str) {
        if let Some(dialog) = self.tab(id).and_then(|t| t.dialog.as_ref()) {
            self.answer_dialog(id, dialog.id, DialogAnswer::default());
        }
    }
    pub(super) fn close_popups(&mut self, opener: &TabId) {
        let children: Vec<_> = self
            .tabs
            .iter()
            .filter(|t| t.opener.as_ref() == Some(opener))
            .map(|t| t.id.clone())
            .collect();
        for child in children {
            self.close(&child);
        }
    }
    #[cfg(feature = "cef")]
    pub(super) fn adopt_popup(&mut self, opener: &TabId, child: EngineChild, url: String) {
        let Some(source) = self.tab(opener).cloned() else {
            return;
        };
        self.next_id += 1;
        let id = TabId(format!("t{}", self.next_id).into());
        self.tabs.push(Tab {
            id: id.clone(),
            owner: source.owner,
            profile: source.profile,
            url,
            title: String::new(),
            favicon: String::new(),
            status: TabStatus::Idle,
            can_back: false,
            can_forward: false,
            placeholder: false,
            opener: Some(opener.clone()),
            popup: true,
            blocked_popup: None,
            dialog: None,
            picking: false,
            selections: Vec::new(),
            pick_hover: None,
            pick: Default::default(),
        });
        self.engine.adopt(&id, child);
    }
    #[cfg(feature = "cef")]
    pub(super) fn popup_event(&mut self, event: &PageEvent) -> bool {
        match &event.change {
            PageChange::PopupNewTab(url) => {
                if let Some(owner) = self.tab(&event.page).map(|t| t.owner.clone()) {
                    let _ = self.create(owner, Some(url), false);
                }
            }
            PageChange::PopupBlocked { url, reason } => {
                if let Some(tab) = self.tabs.iter_mut().find(|t| t.id == event.page) {
                    tab.blocked_popup = Some(BlockedPopup {
                        url: url.clone(),
                        site: site(&tab.url),
                        reason,
                    });
                }
            }
            PageChange::PopupOpened { child, url } => {
                if let Some(tab) = self.tabs.iter_mut().find(|t| t.id == event.page) {
                    tab.blocked_popup = None;
                }
                self.adopt_popup(&event.page, *child, url.clone());
            }
            PageChange::CloseRequested => self.close(&event.page),
            _ => return false,
        }
        true
    }
}
