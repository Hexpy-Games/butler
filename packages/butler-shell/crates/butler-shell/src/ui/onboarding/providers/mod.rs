//! Picking an AI (`FirstRunProviderList`, `firstRunCardView`, `useLocalModelServers`,
//! `useOnlineStatus`, `app/setupProviders.ts`): the cards, the local model servers and the list
//! screen.
//!
//! Online status: the OS network status (`lifecycle::network`, the rule of `navigator.onLine`),
//! not the Agent's answer; an unreachable Agent is the readiness view's state.
mod copy;
mod options;
mod screen;

use std::{iter, rc::Rc};

use butler_ds::ui::context::Lang;
use gpui::{Context, SharedString};
use serde_json::Value;

use crate::lifecycle::network;
use crate::ui::settings::sections::models::manage::Catalog;
use crate::ui::source::agent::Jobs;
use copy::local_model_count;
use options::{Server, model_options, parse_servers};

pub(crate) use options::{LocalModelOption, custom_model_options};
pub(crate) use screen::screen;

/// `FirstRunProviderCardId`: ChatGPT sign-in, Other, or one catalog provider's API key.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum CardId {
    Chatgpt,
    Other,
    Key(SharedString),
}

/// The API key picks on top, in order: (provider, harness slug).
const TOP_PICKS: [(&str, &str); 2] = [("anthropic", "claude"), ("google", "gemini")];

/// One hosted provider of the catalog, in catalog order (parsed once, when the catalog is set).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProviderEntry {
    pub(crate) id: SharedString,
    pub(crate) label: SharedString,
}

/// The catalog's hosted providers (`Catalog::hosted_providers`); empty when `raw` is no catalog.
pub(crate) fn hosted_entries(raw: &Value) -> Rc<[ProviderEntry]> {
    Catalog::parse(raw)
        .map(|catalog| {
            catalog
                .hosted_providers()
                .map(|provider| ProviderEntry {
                    id: provider.provider_id.clone().into(),
                    label: provider.provider_label.clone().into(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// How a card connects: browser sign-in, one API key, or Other.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CardKind {
    SignIn,
    Key,
    Custom,
}

impl CardId {
    pub(crate) fn kind(&self) -> CardKind {
        match self {
            Self::Chatgpt => CardKind::SignIn,
            Self::Other => CardKind::Custom,
            Self::Key(_) => CardKind::Key,
        }
    }

    /// The catalog provider the card connects.
    pub(crate) fn provider_id(&self) -> &str {
        match self {
            Self::Chatgpt => "openai",
            Self::Other => "local",
            Self::Key(id) => id.as_ref(),
        }
    }

    /// `first-run-card-<slug>` / element ids: the top picks keep their harness names, a key card its provider.
    pub(crate) fn slug(&self) -> &str {
        match self {
            Self::Chatgpt => "chatgpt",
            Self::Other => "other",
            Self::Key(id) => TOP_PICKS
                .iter()
                .find(|pick| pick.0 == &**id)
                .map_or(id.as_ref(), |pick| pick.1),
        }
    }
}

/// ChatGPT, then the API key picks on top.
pub(crate) fn top_cards() -> Vec<CardId> {
    iter::once(CardId::Chatgpt)
        .chain(TOP_PICKS.iter().map(|pick| CardId::Key(pick.0.into())))
        .collect()
}

/// The service's own API key page; a provider without one shows no link (as Electron, FirstRunKeyForm.tsx:59).
pub(crate) fn key_url(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "anthropic" => Some("https://console.anthropic.com/settings/keys"),
        "google" => Some("https://aistudio.google.com/apikey"),
        "openai" => Some("https://platform.openai.com/api-keys"),
        "xai" => Some("https://console.x.ai"),
        "kimi" => Some("https://platform.moonshot.ai/console/api-keys"),
        "zai" | "zai-api" => Some("https://z.ai/manage-apikey/apikey-list"),
        _ => None,
    }
}

/// The card's name: its own copy where the list always had one, else its catalog label, else its id.
pub(crate) fn card_name(card: &CardId, lang: Lang, hosted: &[ProviderEntry]) -> SharedString {
    copy::known_name(lang, card)
        .map(SharedString::from)
        .or_else(|| {
            hosted
                .iter()
                .find(|entry| entry.id == card.provider_id())
                .filter(|entry| !entry.label.is_empty())
                .map(|entry| entry.label.clone())
        })
        .unwrap_or_else(|| card.provider_id().to_owned().into())
}

/// `connectionCardId`: the card a connected model came from. Models on this computer and typed
/// servers both come from Other; ChatGPT sign-in and an OpenAI API key are separate cards for one
/// provider.
pub(crate) fn connection_card_id(model: &Value) -> Option<CardId> {
    let provider = model
        .get("provider_id")
        .and_then(Value::as_str)
        .filter(|provider| !provider.is_empty())?;
    if provider == "local" {
        return Some(CardId::Other);
    }
    if model.get("auth_type").and_then(Value::as_str) == Some("chatgpt_oauth") {
        return Some(CardId::Chatgpt);
    }
    Some(CardId::Key(provider.to_owned().into()))
}

/// The local model servers, the online status and the catalog's hosted providers.
#[derive(Default)]
pub(crate) struct LocalServers {
    servers: Vec<Server>,
    options: Vec<LocalModelOption>,
    checking: bool,
    /// The latest lookup; an older one's answer is dropped.
    request: u64,
    /// The OS network status.
    online: bool,
    hosted: Rc<[ProviderEntry]>,
    /// The Agent-ready value of the last lookup while the AI step shows; unset off the step.
    seen: Option<bool>,
}

impl LocalServers {
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        let online = network::online(cx);
        if let Some(status) = network::entity(cx) {
            cx.observe(&status, |this, status, cx| {
                this.online = status.read(cx).online;
                cx.notify();
            })
            .detach();
        }
        Self {
            online,
            ..Self::default()
        }
    }

    /// The catalog's hosted providers, parsed once when the onboarding's catalog is set.
    pub(crate) fn set_catalog(&mut self, raw: &Value, cx: &mut Context<Self>) {
        self.hosted = hosted_entries(raw);
        cx.notify();
    }

    pub(crate) fn hosted(&self) -> Rc<[ProviderEntry]> {
        self.hosted.clone()
    }

    /// The frame calls it on every flow change; it looks the servers up again each time the AI
    /// step opens and when the Agent becomes ready or stops being ready while it shows.
    pub(crate) fn refresh(&mut self, shown: bool, ready: bool, cx: &mut Context<Self>) {
        if !shown {
            self.seen = None;
            return;
        }
        if self.seen != Some(ready) {
            self.seen = Some(ready);
            self.fetch(cx);
        }
    }

    /// "Check again".
    pub(crate) fn rescan(&mut self, cx: &mut Context<Self>) {
        self.fetch(cx);
    }

    pub(crate) fn online(&self) -> bool {
        self.online
    }

    pub(crate) fn checking(&self) -> bool {
        self.checking
    }

    pub(crate) fn options(&self) -> &[LocalModelOption] {
        &self.options
    }

    pub(crate) fn reachable(&self) -> bool {
        self.servers.iter().any(|server| server.reachable)
    }

    /// Names of the reachable servers.
    pub(crate) fn server_names(&self) -> Vec<&str> {
        self.servers
            .iter()
            .filter(|server| server.reachable)
            .map(|server| {
                if server.label.is_empty() {
                    server.id.as_str()
                } else {
                    server.label.as_str()
                }
            })
            .collect()
    }

    /// `firstRunCardView`'s Other description: the models found and where.
    fn found(&self, lang: butler_ds::ui::context::Lang) -> Option<SharedString> {
        (!self.options.is_empty()).then(|| {
            let count = local_model_count(lang, self.options.len());
            format!("{count} · {}", self.server_names().join(", ")).into()
        })
    }

    fn fetch(&mut self, cx: &mut Context<Self>) {
        self.request += 1;
        let request = self.request;
        self.checking = true;
        let lookup = Jobs::run(cx, |client| async move {
            client.get_local_model_servers().await.ok()
        });
        cx.spawn(async move |this, cx| {
            let reply = lookup.await.flatten();
            let _ = this.update(cx, |this, cx| this.loaded(request, reply.as_ref(), cx));
        })
        .detach();
    }

    fn loaded(&mut self, request: u64, reply: Option<&Value>, cx: &mut Context<Self>) {
        if request != self.request {
            return;
        }
        let servers = reply.map(parse_servers).unwrap_or_default();
        self.checking = false;
        if self.servers != servers {
            self.options = model_options(&servers);
            self.servers = servers;
        }
        cx.notify();
    }
}
