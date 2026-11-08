//! Other (`FirstRunCustomServer`, `FirstRunModelPicker`, the discover call of
//! `settings/localModelApi.ts`): models found on this computer (Ollama, LM Studio) as choices,
//! then a typed OpenAI-compatible server. A model connects with Next; the server choice finds
//! its models first, and they open the model picker.
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::choice_card::{ChoiceCard, ChoiceCardList, ChoiceState};
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::blocks::setup_wizard_step_card::SetupWizardStepAction;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::field::{Field, FieldError, FieldLabel};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::Inline;
use butler_ds::ui::provider_logo::{ProviderLogo, provider_logo_name};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::text::Input;
use butler_ds::ui::typo::{Tone, Typo};
use butler_shell_client::Error;
use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, IntoElement as _, ParentElement as _,
    SharedString, Window, div,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::Failure;
use super::copy::{Words, words};
use crate::ui::onboarding::card::step_card;
use crate::ui::onboarding::copy::words as shared;
use crate::ui::onboarding::providers::{self, LocalModelOption, LocalServers};
use crate::ui::onboarding::{ConnectView, Onboarding};
use crate::ui::settings::state::fetch;

mod picker;

/// Other: a server address found models (`Models`), or one was picked (`Pick`).
pub(crate) enum CustomEvent {
    Models {
        options: Rc<[LocalModelOption]>,
        api_key: Option<SharedString>,
    },
    Pick {
        option: LocalModelOption,
        api_key: Option<SharedString>,
    },
}

/// The decoded `LocalModelDiscoveryResult`.
#[derive(Deserialize)]
struct Discovered {
    server_url: Option<String>,
    #[serde(default)]
    models: Vec<Value>,
}

/// Other: models on this computer and a server address.
#[expect(
    clippy::struct_excessive_bools,
    reason = "FirstRunCustomServer's useState flags"
)]
pub(crate) struct CustomServer {
    /// The model chosen (the first when unset); the model picker shares it.
    choice: Option<SharedString>,
    /// "Your own server" is chosen.
    server: bool,
    url: SharedString,
    api_key: SharedString,
    busy: bool,
    failed: bool,
    /// A model was sent to connect.
    picking: bool,
}

impl EventEmitter<CustomEvent> for CustomServer {}

impl CustomServer {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let _ = (window, cx);
        Self {
            choice: None,
            server: false,
            url: SharedString::default(),
            api_key: SharedString::default(),
            busy: false,
            failed: false,
            picking: false,
        }
    }

    /// The chosen model: none for the server choice, else the one picked, else the first.
    fn selected<'a>(&self, options: &'a [LocalModelOption]) -> Option<&'a LocalModelOption> {
        if self.server {
            return None;
        }
        self.choice
            .as_ref()
            .and_then(|key| options.iter().find(|option| &option.key == key))
            .or(options.first())
    }

    fn choose_model(&mut self, key: SharedString, cx: &mut Context<Self>) {
        self.choice = Some(key);
        self.server = false;
        cx.notify();
    }

    fn choose_server(&mut self, cx: &mut Context<Self>) {
        self.server = true;
        cx.notify();
    }

    fn pick(
        &mut self,
        option: LocalModelOption,
        api_key: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        self.picking = true;
        cx.emit(CustomEvent::Pick { option, api_key });
        cx.notify();
    }

    /// `useServerForm.connect`: find the models of the typed address.
    fn connect(&mut self, cx: &mut Context<Self>) {
        let url = self.url.trim().to_owned();
        if url.is_empty() || self.busy {
            return;
        }
        self.busy = true;
        self.failed = false;
        cx.notify();
        let key = Some(self.api_key.trim().to_owned()).filter(|key| !key.is_empty());
        let mut body = json!({
            "provider_id": "local",
            "api_type": "openai_compatible",
            "platform": "custom",
            "server_url": url,
        });
        if let Some(key) = &key {
            body["api_key"] = json!(key);
        }
        fetch(
            cx,
            move |client| async move { client.discover_local_models(&body).await },
            move |this: &mut Self, result: Result<Discovered, Error>, cx| {
                this.busy = false;
                let Ok(found) = result else {
                    this.failed = true;
                    return;
                };
                let address = found.server_url.filter(|address| !address.is_empty());
                let options = providers::custom_model_options(
                    address.as_deref().unwrap_or(&url),
                    &found.models,
                );
                this.choice = None;
                this.server = false;
                this.picking = false;
                cx.emit(CustomEvent::Models {
                    options: Rc::from(options),
                    api_key: key.map(Into::into),
                });
            },
        );
    }
}

/// Other's address form, or its model list (`ConnectView::CustomModels`).
pub(crate) fn custom_screen(
    view: &Onboarding,
    window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let _ = window;
    let Some(server) = view.custom.clone() else {
        return div().into_any_element();
    };
    match &view.stages.view {
        ConnectView::CustomModels { options, api_key } => {
            picker::screen(view, &server, options, api_key.as_ref(), cx)
        }
        _ => server_screen(view, &server, cx),
    }
}

/// `connected`, and whether the commit failed (its notice carries the Retry).
fn connection(view: &Onboarding, cx: &App) -> (bool, bool) {
    let commit = view.commit.read(cx);
    (commit.connected().is_some(), commit.failed())
}

/// `ModelLogo`: the local server's logo, else the server mark.
fn model_logo(platform: &str, cx: &App) -> AnyElement {
    match provider_logo_name("local", Some(platform), false) {
        Some(name) => ProviderLogo::new(name).into_any_element(),
        None => icon(Icon::Server, IconSize::Md, Ds::get(cx)).into_any_element(),
    }
}

fn connected_notice(copy: &Words, cx: &App) -> AnyElement {
    Notice::new(NoticeTone::Neutral, copy.key_valid)
        .icon(icon(Icon::CheckCircle2, IconSize::Md, Ds::get(cx)))
        .into_any_element()
}

/// One radio card per model.
fn model_cards(
    options: &[LocalModelOption],
    selected: Option<&LocalModelOption>,
    disabled: bool,
    server: &Entity<CustomServer>,
    cx: &App,
) -> Vec<AnyElement> {
    options
        .iter()
        .map(|option| {
            let (entity, key) = (server.clone(), option.key.clone());
            let mut card = ChoiceCard::new(
                SharedString::from(format!("first-run-model-{}", option.key)),
                model_logo(&option.platform, cx),
                option.model_id.clone(),
            )
            .chevron(false)
            .selected(selected.is_some_and(|chosen| chosen.key == option.key))
            .on_click(move |_, _, cx| {
                entity.update(cx, |server, cx| server.choose_model(key.clone(), cx));
            });
            if disabled {
                card = card.state(ChoiceState::Disabled);
            }
            if let Some(size) = &option.size_label {
                card = card.meta(size.clone());
            }
            card.into_any_element()
        })
        .collect()
}

/// What the address screen reads of the entities, so the render holds no borrow.
#[expect(
    clippy::struct_excessive_bools,
    reason = "the render's flags, read once"
)]
struct Snapshot {
    model: Option<LocalModelOption>,
    url: SharedString,
    api_key: SharedString,
    busy: bool,
    failed: bool,
    connected: bool,
    /// A model was sent and the connection is being made.
    connecting: bool,
}

fn snapshot(
    view: &Onboarding,
    server: &Entity<CustomServer>,
    options: &[LocalModelOption],
    cx: &App,
) -> Snapshot {
    let state = server.read(cx);
    let (connected, commit_failed) = connection(view, cx);
    Snapshot {
        model: state.selected(options).cloned(),
        url: state.url.clone(),
        api_key: state.api_key.clone(),
        busy: state.busy,
        failed: state.failed,
        connected,
        connecting: state.picking && !connected && !commit_failed,
    }
}

/// Next for a model (or a connected one), else Connect for the typed address.
fn server_action(
    copy: &Words,
    snap: &Snapshot,
    server: &Entity<CustomServer>,
    cx: &mut Context<Onboarding>,
) -> SetupWizardStepAction {
    let entity = server.clone();
    if snap.connected {
        return SetupWizardStepAction::new("first-run-custom-next", copy.next)
            .forward()
            .on_click(cx.listener(|view, _, _, cx| view.open_reply(cx)));
    }
    if let Some(option) = snap.model.clone() {
        let label = if snap.connecting {
            copy.connecting
        } else {
            copy.next
        };
        let action = SetupWizardStepAction::new("first-run-custom-next", label)
            .forward()
            .on_click(move |_, _, cx| {
                entity.update(cx, |server, cx| server.pick(option.clone(), None, cx));
            });
        return if snap.connecting {
            action.disabled()
        } else {
            action
        };
    }
    let label = if snap.busy {
        copy.checking
    } else {
        copy.custom_connect
    };
    let action = SetupWizardStepAction::new("first-run-custom-next", label)
        .forward()
        .on_click(move |_, _, cx| {
            entity.update(cx, CustomServer::connect);
        });
    if snap.url.trim().is_empty() || snap.busy {
        action.disabled()
    } else {
        action
    }
}

fn server_screen(
    view: &Onboarding,
    server: &Entity<CustomServer>,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let copy = words(view.lang);
    let (options, checking) = {
        let local = view.providers.read(cx);
        (local.options().to_vec(), local.checking())
    };
    let snap = snapshot(view, server, &options, cx);
    let action = server_action(copy, &snap, server, cx);
    let mut body = Vec::new();
    if snap.connected {
        body.push(connected_notice(copy, cx));
    } else {
        body.push(if options.is_empty() {
            local_search(copy, checking, view)
        } else {
            let mut cards = model_cards(&options, snap.model.as_ref(), snap.connecting, server, cx);
            let own = server_card(copy, snap.model.is_none(), snap.connecting, server, cx);
            cards.push(own);
            ChoiceCardList::new().children(cards).into_any_element()
        });
        if snap.model.is_none() {
            let (url, key) = (snap.url.clone(), snap.api_key.clone());
            body.extend(server_fields(copy, url, key, snap.failed, server));
        }
    }
    let mut card = step_card(view, "custom", copy.other_title, body, cx)
        .description(copy.other_body)
        .on_back(
            shared(view.lang).back,
            cx.listener(|view, _, _, cx| view.back_to_list(cx)),
        )
        .action(action);
    if snap.model.is_some() && !snap.connected {
        card = card.footer_start(Typo::caption(copy.local_note).tone(Tone::Tertiary));
    }
    card.into_any_element()
}

/// The "Your own server" radio card.
fn server_card(
    copy: &Words,
    selected: bool,
    disabled: bool,
    server: &Entity<CustomServer>,
    cx: &App,
) -> AnyElement {
    let entity = server.clone();
    let mut card = ChoiceCard::new(
        "first-run-model-server",
        icon(Icon::Server, IconSize::Md, Ds::get(cx)),
        copy.other_server,
    )
    .description(copy.custom_body)
    .chevron(false)
    .selected(selected)
    .on_click(move |_, _, cx| {
        entity.update(cx, CustomServer::choose_server);
    });
    if disabled {
        card = card.state(ChoiceState::Disabled);
    }
    card.into_any_element()
}

/// No local model yet: say how to get one, with Check again.
fn local_search(copy: &Words, checking: bool, view: &Onboarding) -> AnyElement {
    if checking {
        return Inline::new()
            .child(Spinner::new("first-run-local-spinner").size(14.))
            .child(Typo::caption(copy.checking).tone(Tone::Secondary))
            .into_any_element();
    }
    let providers = view.providers.clone();
    Inline::new()
        .child(Typo::caption(copy.local_missing).tone(Tone::Secondary))
        .child(
            Button::new("first-run-local-rescan")
                .size(Size::Sm)
                .variant(Variant::Link)
                .text(copy.rescan)
                .on_click(move |_, _, cx| {
                    providers.update(cx, LocalServers::rescan);
                }),
        )
        .into_any_element()
}

/// `ServerFields`: the address and the optional API key.
fn server_fields(
    copy: &Words,
    url: SharedString,
    api_key: SharedString,
    failed: bool,
    server: &Entity<CustomServer>,
) -> [AnyElement; 2] {
    let (edit_url, edit_key) = (server.clone(), server.clone());
    let mut address = Input::new("first-run-server-url")
        .placeholder("http://127.0.0.1:8080/v1")
        .value(url)
        .on_change(move |text, _, cx| {
            edit_url.update(cx, |server, _| server.url = text.to_owned().into());
        });
    if failed {
        address = address.invalid();
    }
    let url_field = Field::new("first-run-server-url-field")
        .child(FieldLabel::new().child(copy.custom_url))
        .child(address)
        .children(
            failed.then(|| FieldError::new().child(copy.key_errors[Failure::Network as usize])),
        )
        .into_any_element();
    let key_field = Field::new("first-run-server-key-field")
        .child(FieldLabel::new().child(copy.custom_key))
        .child(
            Input::new("first-run-server-key")
                .masked()
                .value(api_key)
                .on_change(move |text, _, cx| {
                    edit_key.update(cx, |server, _| server.api_key = text.to_owned().into());
                }),
        )
        .into_any_element();
    [url_field, key_field]
}
