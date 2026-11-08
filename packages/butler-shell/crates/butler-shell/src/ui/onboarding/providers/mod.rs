//! Picking an AI (`FirstRunProviderList`, `firstRunCardView`, `useLocalModelServers`,
//! `useOnlineStatus`, `app/setupProviders.ts`): the cards, the local model servers and the list
//! screen.
//!
//! Online status: gpui has no `navigator.onLine`, so the rule is the Agent's own answer. The
//! list is online until the local-model-servers request gets no reply (no Agent, or the call
//! failed); it is online again as soon as one succeeds.
mod copy;
mod options;
mod screen;

use gpui::{Context, SharedString};
use serde_json::Value;

use crate::ui::source::agent::Jobs;
use copy::local_model_count;
use options::{Server, model_options, parse_servers};

pub(crate) use options::{LocalModelOption, custom_model_options};
pub(crate) use screen::screen;

/// `FirstRunProviderCardId`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum CardId {
    Chatgpt,
    Claude,
    Gemini,
    Openai,
    Grok,
    Qwen,
    Kimi,
    ZaiCoding,
    ZaiApi,
    OpencodeGo,
    Other,
}

/// How a card connects: browser sign-in, one API key, or Other.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CardKind {
    SignIn,
    Key,
    Custom,
}

/// `ProviderCardSpec`.
#[derive(Debug)]
pub(crate) struct ProviderCard {
    pub(crate) id: CardId,
    pub(crate) kind: CardKind,
    /// The catalog provider the card connects.
    pub(crate) provider_id: Option<&'static str>,
    /// The service's own API key page.
    pub(crate) key_url: Option<&'static str>,
}

const fn spec(
    id: CardId,
    kind: CardKind,
    provider_id: &'static str,
    key_url: Option<&'static str>,
) -> ProviderCard {
    ProviderCard {
        id,
        kind,
        provider_id: Some(provider_id),
        key_url,
    }
}

/// `PROVIDER_CARDS`, in `CardId` order.
static CARDS: [ProviderCard; 11] = [
    spec(CardId::Chatgpt, CardKind::SignIn, "openai", None),
    spec(
        CardId::Claude,
        CardKind::Key,
        "anthropic",
        Some("https://console.anthropic.com/settings/keys"),
    ),
    spec(
        CardId::Gemini,
        CardKind::Key,
        "google",
        Some("https://aistudio.google.com/apikey"),
    ),
    spec(
        CardId::Openai,
        CardKind::Key,
        "openai",
        Some("https://platform.openai.com/api-keys"),
    ),
    spec(
        CardId::Grok,
        CardKind::Key,
        "xai",
        Some("https://console.x.ai"),
    ),
    spec(CardId::Qwen, CardKind::Key, "qwen", None),
    spec(
        CardId::Kimi,
        CardKind::Key,
        "kimi",
        Some("https://platform.moonshot.ai/console/api-keys"),
    ),
    spec(
        CardId::ZaiCoding,
        CardKind::Key,
        "zai",
        Some("https://z.ai/manage-apikey/apikey-list"),
    ),
    spec(
        CardId::ZaiApi,
        CardKind::Key,
        "zai-api",
        Some("https://z.ai/manage-apikey/apikey-list"),
    ),
    spec(CardId::OpencodeGo, CardKind::Key, "opencode-go", None),
    spec(CardId::Other, CardKind::Custom, "local", None),
];

pub(crate) fn card(id: CardId) -> &'static ProviderCard {
    &CARDS[id as usize]
}

/// `connectionCardId`: the card a connected model came from. Models on this computer and typed
/// servers both come from Other; ChatGPT sign-in and an OpenAI API key are separate cards for one
/// provider.
pub(crate) fn connection_card_id(model: &Value) -> Option<CardId> {
    let provider = model.get("provider_id").and_then(Value::as_str)?;
    if provider == "local" {
        return Some(CardId::Other);
    }
    if model.get("auth_type").and_then(Value::as_str) == Some("chatgpt_oauth") {
        return Some(CardId::Chatgpt);
    }
    CARDS
        .iter()
        .find(|card| card.kind == CardKind::Key && card.provider_id == Some(provider))
        .map(|card| card.id)
}

/// `useLocalModelServers` and the online status.
#[derive(Default)]
pub(crate) struct LocalServers {
    servers: Vec<Server>,
    options: Vec<LocalModelOption>,
    checking: bool,
    /// The last request got no reply.
    failed: bool,
    fetched: bool,
    /// "More services" opened or closed by the user; unset follows the AI in use.
    more_open: Option<bool>,
}

impl LocalServers {
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        let _ = cx;
        Self::default()
    }

    /// The frame calls it on every flow change while the AI step shows; it fetches only when
    /// it has not yet, or the last try got no answer (the Agent was not ready).
    pub(crate) fn refresh(&mut self, cx: &mut Context<Self>) {
        if !self.fetched || self.failed {
            self.fetch(cx);
        }
    }

    /// "Check again".
    pub(crate) fn rescan(&mut self, cx: &mut Context<Self>) {
        self.fetch(cx);
    }

    pub(crate) fn online(&self) -> bool {
        !self.failed
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
        if self.checking {
            return;
        }
        self.checking = true;
        let request = Jobs::run(cx, |client| async move {
            client.get_local_model_servers().await.ok()
        });
        cx.spawn(async move |this, cx| {
            let reply = request.await.flatten();
            let _ = this.update(cx, |this, cx| this.loaded(reply.as_ref(), cx));
        })
        .detach();
    }

    fn loaded(&mut self, reply: Option<&Value>, cx: &mut Context<Self>) {
        let servers = reply.map(parse_servers).unwrap_or_default();
        let failed = reply.is_none();
        let changed = self.failed != failed || self.servers != servers || !self.fetched;
        self.checking = false;
        self.fetched = true;
        self.failed = failed;
        if self.servers != servers {
            self.options = model_options(&servers);
            self.servers = servers;
        }
        if changed {
            cx.notify();
        }
    }
}
