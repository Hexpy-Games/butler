//! Synchronous policy mirror: no gpui access while CEF pumps.
use butler_cef_host::osr::{PopupDecision, PopupRequest};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    time::Instant,
};

#[derive(Default)]
pub(super) struct PopupGate {
    pub(super) pages: HashMap<u64, GatePage>,
    pub(super) owners: HashMap<String, usize>,
    pub(super) next_id: Rc<Cell<u64>>,
}
pub(super) struct GatePage {
    pub(super) owner_key: String,
    pub(super) url: String,
    pub(super) last_input: Rc<Cell<Option<Instant>>>,
    pub(super) allowance: Option<String>,
}
impl PopupGate {
    pub(super) fn insert(&mut self, id: u64, owner_key: String, url: String) {
        *self.owners.entry(owner_key.clone()).or_default() += 1;
        self.pages.insert(
            id,
            GatePage {
                owner_key,
                url,
                last_input: Rc::default(),
                allowance: None,
            },
        );
    }
    pub(super) fn remove(&mut self, id: u64) {
        if let Some(page) = self.pages.remove(&id)
            && let Some(count) = self.owners.get_mut(&page.owner_key)
        {
            *count -= 1;
        }
    }
}
pub(super) fn policy(gate: Rc<RefCell<PopupGate>>) -> butler_cef_host::osr::PopupPolicy {
    Rc::new(move |request| {
        let mut gate = gate.borrow_mut();
        let decision = popup_decision(&gate, request, Instant::now());
        if let PopupDecision::Allow { child } = decision
            && let Some(source) = gate.pages.get_mut(&request.opener)
        {
            let owner = source.owner_key.clone();
            source.allowance = None;
            gate.next_id.set(child);
            gate.insert(child, owner, request.url.clone());
        }
        decision
    })
}

pub(super) fn popup_decision(
    gate: &PopupGate,
    request: &PopupRequest,
    now: Instant,
) -> PopupDecision {
    use butler_cef_host::osr::{PopupBlock, PopupDisposition};
    let Some(source) = gate.pages.get(&request.opener) else {
        return PopupDecision::Block(PopupBlock::NoGesture);
    };
    let web = super::address::web_url(&request.url).is_some();
    let once = source.allowance.as_deref() == Some(super::popups::site(&source.url).as_str());
    // Electron marks window.open as programmatic, so Allow preserves its popup and opener.
    if !once && web && request.disposition == PopupDisposition::NewTab {
        return PopupDecision::NewTab;
    }
    if gate.owners.get(&source.owner_key).copied().unwrap_or(0) >= 30 {
        return PopupDecision::Block(PopupBlock::TabBudget);
    }
    let recent = source
        .last_input
        .get()
        .is_some_and(|at| now.saturating_duration_since(at) < std::time::Duration::from_secs(5));
    if (web || request.url == "about:blank") && (request.user_gesture || recent || once) {
        PopupDecision::Allow {
            child: gate.next_id.get() + 1,
        }
    } else {
        PopupDecision::Block(PopupBlock::NoGesture)
    }
}
