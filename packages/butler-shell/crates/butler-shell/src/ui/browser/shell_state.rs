//! In-memory conversation browser preferences (`browserShellState.ts`).
use super::{
    engine::TabId,
    model::{BrowserState, Owner},
};
use gpui::{App, Global};
use std::collections::HashMap;

#[derive(Default)]
pub(crate) struct ConversationBrowser {
    pub(crate) open: bool,
    pub(crate) last_tab: Option<TabId>,
    raised: u64,
}
#[derive(Default)]
pub(crate) struct BrowserShell {
    pub(crate) address_focus: Option<Owner>,
    conversations: HashMap<String, ConversationBrowser>,
}
impl Global for BrowserShell {}
impl BrowserShell {
    pub(crate) fn set_open(&mut self, session: &str, open: bool) {
        let pane = self.conversations.entry(session.to_owned()).or_default();
        pane.open = open;
        if open {
            pane.raised = crate::ui::viewer::state::raise_right_slot();
        }
    }
    pub(crate) fn remember_tab(&mut self, session: &str, tab: TabId) {
        self.conversations
            .entry(session.to_owned())
            .or_default()
            .last_tab = Some(tab);
    }
    pub(crate) fn remembered(&self, session: &str) -> Option<&TabId> {
        self.conversations.get(session)?.last_tab.as_ref()
    }
}
pub(crate) fn browser_raise(session: &str, cx: &App) -> Option<u64> {
    let pane = cx.global::<BrowserShell>().conversations.get(session)?;
    (pane.open && cx.global::<BrowserState>().enabled()).then_some(pane.raised)
}
pub(crate) fn open_conversation(session: &str, cx: &mut App) {
    let remembered = cx.global::<BrowserShell>().remembered(session).cloned();
    let model = cx.global::<BrowserState>();
    let tabs = || {
        model
            .tabs()
            .iter()
            .filter(|t| t.owner == Owner::Conversation(session.to_owned().into()))
    };
    let target = tabs()
        .find(|t| Some(&t.id) == remembered.as_ref())
        .or_else(|| tabs().next())
        .map(|t| t.id.clone());
    cx.global_mut::<BrowserShell>().set_open(session, true);
    if let Some(id) = target {
        cx.global_mut::<BrowserShell>()
            .remember_tab(session, id.clone());
        cx.global_mut::<BrowserState>().activate(&id);
    }
    cx.refresh_windows();
}
