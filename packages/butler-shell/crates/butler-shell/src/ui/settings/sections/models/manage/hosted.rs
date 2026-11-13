//! `HostedModelForm.tsx`, `HostedModelSelectFields.tsx`, `HostedCredentialSection.tsx`,
//! `HostedModelSaveButton.tsx` and `useHostedModelForm.ts`: register (or re-register) a hosted
//! model. The provider is chosen by the page (`showProviderSelect` is false there).
//! CARVE-OUT(chatgptSignInKind): React's `openChatGptSignIn` asks the form to start a sign-in
//! through the settings store; the frame has no such request.
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::button::{self, Button, Size};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::Justify;
use butler_ds::ui::toast::{Toast, ToastId};
use butler_ds::ui::tooltip::Tooltip;
use butler_shell_client::Error;
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, IntoElement as _,
    ParentElement as _, SharedString, Window,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::card::ChatGptCard;
use super::catalog::{
    API_KEY, CHATGPT_OAUTH, Catalog, CatalogModel, Credential, NEW_CREDENTIAL_ID,
};
use super::copy::words;
use super::credentials::{self, CredentialForm, edit_handler};
use super::notify;
use crate::ui::settings::SectionCtx;
use crate::ui::settings::controls::{SettingsOption, SettingsSelect};
use crate::ui::settings::state::fetch;

/// The model was registered: the page goes back to the list.
pub(super) struct Saved;

#[derive(Deserialize)]
struct Registered {
    model: CatalogModel,
}

pub(super) struct HostedForm {
    ctx: SectionCtx,
    /// The model being edited, none when adding.
    edit_ref: Option<SharedString>,
    card: Entity<ChatGptCard>,
    form: CredentialForm,
    model_ref: String,
    /// The provider, catalog default URL and edited URL the base URL draft follows.
    base_key: Option<(String, String, Option<String>)>,
    initialized: bool,
    busy: bool,
    toast: Option<ToastId>,
}

impl EventEmitter<Saved> for HostedForm {}

/// What the catalog says about the chosen provider.
struct Derived<'a> {
    models: Vec<&'a CatalogModel>,
    auth_methods: Vec<String>,
    credentials: Vec<&'a Credential>,
    default_url: &'a str,
}

impl HostedForm {
    pub(super) fn new(
        ctx: SectionCtx,
        edit_ref: Option<SharedString>,
        cx: &mut Context<Self>,
    ) -> Self {
        let editing = edit_ref.is_some();
        let card = cx.new(|cx| ChatGptCard::new(ctx.clone(), editing, cx));
        cx.observe(&card, |_, _, cx| cx.notify()).detach();
        Self {
            ctx,
            edit_ref,
            card,
            form: CredentialForm::new(),
            model_ref: String::new(),
            base_key: None,
            initialized: false,
            busy: false,
            toast: None,
        }
    }

    /// The effects of `useHostedModelForm`: the choices follow the provider and the catalog.
    fn reconcile(&mut self, derived: &Derived, editing: Option<&CatalogModel>, provider: &str) {
        if !self.initialized {
            self.initialized = true;
            self.form.auth_method = editing
                .and_then(|model| model.auth_type.clone())
                .or_else(|| derived.auth_methods.first().cloned())
                .unwrap_or_else(|| API_KEY.to_owned())
                .into();
            self.form.credential_id = editing
                .and_then(|model| model.credential_id.clone())
                .or_else(|| derived.credentials.first().map(|c| c.id.clone()))
                .unwrap_or_else(|| NEW_CREDENTIAL_ID.to_owned())
                .into();
            self.model_ref = editing
                .map(|model| model.model_ref.clone())
                .unwrap_or_default();
        }
        if !derived
            .models
            .iter()
            .any(|model| model.model_ref == self.model_ref)
        {
            self.model_ref = derived
                .models
                .first()
                .map(|model| model.model_ref.clone())
                .unwrap_or_default();
        }
        if !derived
            .auth_methods
            .iter()
            .any(|m| m == &*self.form.auth_method)
        {
            self.form.auth_method = derived
                .auth_methods
                .first()
                .map_or(API_KEY, String::as_str)
                .to_owned()
                .into();
        }
        // `__new` stays chosen: it is the "New credential" option, not a missing credential.
        let known = &*self.form.credential_id == NEW_CREDENTIAL_ID
            || derived
                .credentials
                .iter()
                .any(|c| c.id.as_str() == &*self.form.credential_id);
        if !known {
            self.form.credential_id = derived
                .credentials
                .first()
                .map_or(NEW_CREDENTIAL_ID, |c| c.id.as_str())
                .to_owned()
                .into();
        }
        let edited_url = editing.and_then(|model| model.api_base_url.clone());
        let key = (
            provider.to_owned(),
            derived.default_url.to_owned(),
            edited_url,
        );
        if self.base_key.as_ref() != Some(&key) {
            self.form.api_base_url = key.2.clone().unwrap_or_else(|| key.1.clone());
            self.base_key = Some(key);
        }
    }

    /// `canSave`
    fn can_save(&self, derived: &Derived, cx: &Context<Self>) -> bool {
        let form = &self.form;
        derived
            .models
            .iter()
            .any(|model| model.model_ref == self.model_ref)
            && derived.auth_methods.iter().any(|m| m == &*form.auth_method)
            && if &*form.auth_method == CHATGPT_OAUTH {
                self.card.read(cx).ready()
            } else {
                &*form.credential_id != NEW_CREDENTIAL_ID || !form.api_key.trim().is_empty()
            }
    }

    /// `HostedModelForm`: one form section for the chosen `provider`.
    pub(super) fn section(
        &mut self,
        provider: &str,
        catalog: Option<&Catalog>,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let copy = words(Ds::get(cx).lang());
        let title = if self.edit_ref.is_some() {
            copy.edit_title
        } else {
            copy.add_title
        };
        let section = SettingsSection::new("hosted-model", SettingsSectionKind::Form, title);
        let Some(catalog) = catalog else {
            return section.state(SettingsSectionState::Loading);
        };
        let editing = self.edit_ref.as_ref().and_then(|r| {
            catalog
                .registered_models
                .iter()
                .find(|m| m.model_ref == **r)
        });
        let derived = Derived {
            models: catalog.models(provider),
            auth_methods: catalog.auth_methods(provider),
            credentials: catalog.credentials(provider),
            default_url: catalog.default_api_base_url(provider),
        };
        self.reconcile(&derived, editing, provider);
        let can_save = self.can_save(&derived, cx);
        let mut fields = vec![self.model_select(&derived, cx)];
        if !derived.auth_methods.is_empty() {
            let view = credentials::View {
                catalog,
                provider,
                form: &self.form,
                auth_methods: &derived.auth_methods,
                show_api_base_url: !derived.default_url.is_empty()
                    || editing.is_some_and(|m| m.api_base_url.is_some()),
                chatgpt: Some(self.card.clone().into_any_element()),
            };
            let edit = edit_handler(cx, |this: &mut Self, field, value| {
                this.form.set(field, value);
            });
            fields.extend(credentials::fields(view, &edit, copy));
        }
        fields.push(self.save_button(provider, &derived, can_save, cx));
        section.children(fields)
    }

    /// `HostedModelSelectFields`: the model.
    fn model_select(&self, derived: &Derived, cx: &mut Context<Self>) -> AnyElement {
        let on_change = cx.listener(|this, value: &SharedString, _, cx| {
            this.model_ref = value.to_string();
            cx.notify();
        });
        model_select(&derived.models, &self.model_ref, true, cx, on_change).into_any_element()
    }

    /// `HostedModelSaveButton`: busy shows "Saving"; a disabled ChatGPT add says why.
    fn save_button(
        &self,
        provider: &str,
        derived: &Derived,
        can_save: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let copy = words(Ds::get(cx).lang());
        let label = match (self.busy, self.edit_ref.is_some()) {
            (true, _) => copy.saving,
            (false, true) => copy.save_edit,
            (false, false) => copy.save_add,
        };
        let model_id = derived
            .models
            .iter()
            .find(|model| model.model_ref == self.model_ref)
            .map(|model| model.model_id.clone())
            .unwrap_or_default();
        let (provider, default_url) = (provider.to_owned(), derived.default_url.to_owned());
        let mut button = Button::new("hosted-model-save")
            .text(label)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.save(&provider, &model_id, &default_url, cx);
            }));
        if self.busy || !can_save {
            button = button.disabled();
        }
        let mut tooltip = Tooltip::new("hosted-model-save-hint");
        if &*self.form.auth_method == CHATGPT_OAUTH && !self.card.read(cx).ready() {
            tooltip = tooltip.label(copy.sign_in_add_hint);
        }
        button::container(Size::Default)
            .justify(Justify::End)
            .child(tooltip.child(button))
            .into_any_element()
    }

    /// `registerCurrentModel`
    fn save(&mut self, provider: &str, model_id: &str, default_url: &str, cx: &mut Context<Self>) {
        let form = &self.form;
        let mut body = Map::new();
        body.insert("provider_id".into(), json!(provider));
        body.insert("model_id".into(), json!(model_id));
        body.insert("auth_type".into(), json!(&*form.auth_method));
        if &*form.auth_method == API_KEY {
            if &*form.credential_id == NEW_CREDENTIAL_ID {
                body.insert("api_key".into(), json!(form.api_key));
                body.insert("credential_label".into(), json!(form.credential_label));
            } else {
                body.insert("credential_id".into(), json!(&*form.credential_id));
            }
        }
        let url = form.api_base_url.trim();
        if !url.is_empty() && url != default_url {
            body.insert("api_base_url".into(), json!(url));
        }
        self.busy = true;
        cx.notify();
        fetch(
            cx,
            move |client| async move { client.register_hosted_model(&Value::Object(body)).await },
            |this: &mut Self, result: Result<Registered, Error>, cx| {
                this.busy = false;
                let copy = words(Ds::get(cx).lang());
                match result {
                    Ok(registered) => {
                        this.ctx.reload_catalog(cx);
                        let text = (copy.registered_status)(registered.model.name());
                        notify(&mut this.toast, Toast::success(text), cx);
                        cx.emit(Saved);
                    }
                    Err(_) => notify(&mut this.toast, Toast::error(copy.error_save), cx),
                }
            },
        );
    }
}

/// `HostedModelSelectFields.tsx`: image models opt out of the token caption.
pub(super) fn model_select(
    models: &[&CatalogModel],
    model_ref: &str,
    show_token_caption: bool,
    cx: &App,
    on_change: impl Fn(&SharedString, &mut Window, &mut App) + 'static,
) -> SettingsSelect {
    let lang = Ds::get(cx).lang();
    let options = models
        .iter()
        .map(|model| {
            let label = if show_token_caption {
                model.option_label(lang)
            } else {
                model.name().to_owned()
            };
            SettingsOption::new(model.model_ref.clone(), label)
        })
        .collect();
    SettingsSelect::new(
        "hosted-model-select",
        words(lang).model,
        model_ref.to_owned(),
    )
    .options(options)
    .on_change(on_change)
}
