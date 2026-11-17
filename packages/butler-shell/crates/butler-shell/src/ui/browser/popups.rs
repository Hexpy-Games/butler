use super::{engine::TabId, model::BrowserState, page_dialog::DialogAnswer};
#[cfg(feature = "cef")]
use super::{
    engine::{PageChange, PageEvent},
    model::Tab,
    page_dialog::{BlockedPopup, EngineChild},
};

#[cfg(feature = "cef")]
pub(super) fn site(url: &str) -> String {
    url::Url::parse(url)
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_default()
}
/// Tells the gateway of a pop-up the page host refused on a conversation's tab. A
/// page without a web origin has no `site` to name, so it is not reported.
#[cfg(feature = "cef")]
fn tell_agent(tab: &Tab, url: &str, reason: &str, cx: &mut gpui::App) {
    let key = super::area::owner_key(&tab.owner);
    let Some(session) = key.strip_prefix("conversation:") else {
        return;
    };
    if super::address::web_url(&tab.url).is_none() {
        return;
    }
    let body = serde_json::json!({"op":"popup_blocked","session":session,"tab":tab.id.0.as_ref(),
        "url":url,"site":site(&tab.url),"reason":reason});
    drop(crate::ui::source::agent::Jobs::run(
        cx,
        move |client| async move {
            let _ = client.browser_host_downloads(&body).await;
        },
    ));
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
    pub(super) fn close_popups(&mut self, opener: &TabId, cx: &mut gpui::App) {
        let children: Vec<_> = self
            .tabs
            .iter()
            .filter(|t| t.opener.as_ref() == Some(opener))
            .map(|t| t.id.clone())
            .collect();
        for child in children {
            self.close(&child, cx);
        }
    }
    #[cfg(feature = "cef")]
    pub(super) fn adopt_popup(
        &mut self,
        opener: &TabId,
        child: EngineChild,
        url: String,
    ) -> Option<TabId> {
        let source = self.tab(opener).cloned()?;
        self.next_id += 1;
        let id = TabId(format!("t{}", self.next_id).into());
        // Hosted as the gate decided when the child was created, whoever holds the opener now.
        let hosted = self
            .engine
            .adopt(&id, child)
            .then(|| self.new_hosted(source.hosted.as_ref().is_some_and(|h| h.internal)));
        let awake = hosted.as_ref().map(super::agent_host::Hosted::awake);
        self.tabs.push(Tab {
            opener: Some(opener.clone()),
            popup: hosted.is_none(),
            hosted,
            ..Tab::new(id.clone(), source.owner, source.profile, url)
        });
        if let Some(awake) = awake {
            self.engine.keep_awake(&id, awake);
            self.fix_hosted_size(&id);
        }
        Some(id)
    }
    #[cfg(feature = "cef")]
    pub(super) fn popup_event(&mut self, event: &PageEvent, cx: &mut gpui::App) -> bool {
        match &event.change {
            PageChange::PopupNewTab(url) => {
                if let Some(owner) = self.tab(&event.page).map(|t| t.owner.clone()) {
                    let _ = self.create(owner, Some(url), false, true, cx);
                }
            }
            PageChange::PopupBlocked { url, reason } => {
                if let Some(tab) = self.tabs.iter_mut().find(|t| t.id == event.page) {
                    if tab
                        .hosted
                        .as_ref()
                        .is_some_and(super::agent_host::Hosted::held_by_agent)
                    {
                        // The Agent's own block is no prompt for the user: the Agent hears of it.
                        tell_agent(tab, url, reason, cx);
                    } else {
                        tab.blocked_popup = Some(BlockedPopup {
                            url: url.clone(),
                            site: site(&tab.url),
                            reason,
                        });
                    }
                }
            }
            PageChange::PopupOpened { child, url } => {
                if let Some(tab) = self.tabs.iter_mut().find(|t| t.id == event.page) {
                    tab.blocked_popup = None;
                }
                if let Some(id) = self.adopt_popup(&event.page, *child, url.clone()) {
                    self.announce_popup(&id, &event.page, url, cx);
                }
            }
            PageChange::CloseRequested => self.close(&event.page, cx),
            _ => return false,
        }
        true
    }
}
