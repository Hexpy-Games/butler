//! The commands a page takes from the user: load an address, back, forward, reload, stop.
use gpui::App;

use super::address::address_url;
use super::engine::{PageCommand, TabId};
use super::model::{BrowserError, BrowserState};

impl BrowserState {
    pub(crate) fn navigate(
        &mut self,
        id: &TabId,
        input: &str,
        cx: &mut App,
    ) -> Result<(), BrowserError> {
        self.command_allowed(id)?;
        let Some(url) = address_url(input)? else {
            return Ok(());
        };
        if let Some(tab) = self.tabs.iter_mut().find(|tab| &tab.id == id) {
            tab.placeholder = false;
            tab.last_nav = Some(super::visits::Transition::Typed);
        }
        self.start_engine(cx);
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
        self.agent_gate(id)
    }

    pub(crate) fn back(&mut self, id: &TabId) -> Result<(), BrowserError> {
        self.command_allowed(id)?;
        if self.tab(id).is_some_and(|tab| tab.can_back) {
            self.nav_intent(id, super::visits::Transition::ForwardBack);
            self.engine.command(id, PageCommand::Back);
        }
        Ok(())
    }

    pub(crate) fn forward(&mut self, id: &TabId) -> Result<(), BrowserError> {
        self.command_allowed(id)?;
        if self.tab(id).is_some_and(|tab| tab.can_forward) {
            self.nav_intent(id, super::visits::Transition::ForwardBack);
            self.engine.command(id, PageCommand::Forward);
        }
        Ok(())
    }

    pub(crate) fn reload(&mut self, id: &TabId) -> Result<(), BrowserError> {
        self.command_allowed(id)?;
        self.nav_intent(id, super::visits::Transition::Reload);
        self.engine.command(id, PageCommand::Reload);
        Ok(())
    }

    pub(crate) fn stop(&mut self, id: &TabId) -> Result<(), BrowserError> {
        self.command_allowed(id)?;
        self.engine.command(id, PageCommand::Stop);
        Ok(())
    }

    fn nav_intent(&mut self, id: &TabId, transition: super::visits::Transition) {
        if let Some(tab) = self.tabs.iter_mut().find(|tab| &tab.id == id) {
            tab.last_nav = Some(transition);
        }
    }
}
