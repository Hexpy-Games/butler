//! Synchronous policy mirror: no gpui access while CEF pumps.
use butler_cef_host::osr::{PopupDecision, PopupRequest};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    time::Instant,
};
use url::Url;

/// The sites and exact hosts the Agent's policy lets a page's popups reach.
#[derive(Default)]
pub(super) struct PopupSites {
    pub(super) sites: Vec<String>,
    pub(super) hosts: Vec<String>,
}

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
    /// The Agent's page, held by the Agent: its popups open as pages of the Agent's own, by
    /// `agent_popup_allowed`.
    pub(super) hosted: bool,
    pub(super) popups: Rc<PopupSites>,
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
                hosted: false,
                popups: Rc::default(),
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
            let (owner, hosted, popups) = (
                source.owner_key.clone(),
                source.hosted,
                source.popups.clone(),
            );
            source.allowance = None;
            gate.next_id.set(child);
            gate.insert(child, owner, request.url.clone());
            if let Some(page) = gate.pages.get_mut(&child) {
                page.hosted = hosted;
                page.popups = popups;
            }
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
    let full = gate.owners.get(&source.owner_key).copied().unwrap_or(0) >= 30;
    // The Agent's page follows the Agent's rule alone: any disposition, no gesture.
    if source.hosted {
        return if !agent_popup_allowed(&source.popups, &source.url, &request.url) {
            PopupDecision::Block(PopupBlock::NoGesture)
        } else if full {
            PopupDecision::Block(PopupBlock::TabBudget)
        } else {
            PopupDecision::Allow {
                child: gate.next_id.get() + 1,
            }
        };
    }
    let web = super::address::web_url(&request.url).is_some();
    let once = source.allowance.as_deref() == Some(super::popups::site(&source.url).as_str());
    // Electron marks window.open as programmatic, so Allow preserves its popup and opener.
    if !once && web && request.disposition == PopupDisposition::NewTab {
        return PopupDecision::NewTab;
    }
    if full {
        return PopupDecision::Block(PopupBlock::TabBudget);
    }
    let recent = source
        .last_input
        .get()
        .is_some_and(|at| now.saturating_duration_since(at) < std::time::Duration::from_secs(5));
    let allowed = request.user_gesture || recent || once;
    if (web || request.url == "about:blank") && allowed {
        PopupDecision::Allow {
            child: gate.next_id.get() + 1,
        }
    } else {
        PopupDecision::Block(PopupBlock::NoGesture)
    }
}

/// The Agent's popup rule, as the executor's `popup_allowed`: `about:blank`, a page of the
/// opener's origin, a site or subdomain of one of `popups.sites`, or one of `popups.hosts`.
fn agent_popup_allowed(popups: &PopupSites, parent: &str, raw: &str) -> bool {
    let web = |raw: &str| super::address::web_url(raw).and_then(|url| Url::parse(&url).ok());
    let Some(target) = web(raw) else {
        return raw == "about:blank";
    };
    let host = target.host_str().unwrap_or("");
    web(parent).is_some_and(|parent| parent.origin() == target.origin())
        || popups
            .sites
            .iter()
            .any(|site| host == site || host.ends_with(&format!(".{site}")))
        || popups.hosts.iter().any(|h| h == host)
}
