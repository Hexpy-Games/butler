//! `HostedCredentialFields.tsx` and `HostedCredentialSection.tsx`: the auth method, API base URL,
//! saved credential and new key fields, shared by the hosted model form and the image key form.
use std::rc::Rc;

use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::text::Input;
use gpui::{AnyElement, App, Context, IntoElement as _, SharedString};

use super::catalog::{API_KEY, CHATGPT_OAUTH, Catalog, NEW_CREDENTIAL_ID};
use super::copy::Words;
use crate::ui::settings::controls::{SettingsOption, SettingsSelect};

/// Which field an edit is for.
#[derive(Clone, Copy)]
pub(super) enum Field {
    AuthMethod,
    Credential,
    BaseUrl,
    ApiKey,
    Label,
}

/// The owner's `onChange` of every field.
pub(super) type Edit = Rc<dyn Fn(Field, SharedString, &mut App)>;

/// The drafts of the credential fields (`useHostedModelForm` state).
pub(super) struct CredentialForm {
    pub(super) auth_method: SharedString,
    pub(super) credential_id: SharedString,
    pub(super) api_base_url: String,
    pub(super) api_key: String,
    pub(super) credential_label: String,
}

impl CredentialForm {
    pub(super) fn new() -> Self {
        Self {
            auth_method: API_KEY.into(),
            credential_id: NEW_CREDENTIAL_ID.into(),
            api_base_url: String::new(),
            api_key: String::new(),
            credential_label: String::new(),
        }
    }

    pub(super) fn set(&mut self, field: Field, value: &str) {
        match field {
            Field::AuthMethod => self.auth_method = value.to_owned().into(),
            Field::Credential => self.credential_id = value.to_owned().into(),
            Field::BaseUrl => value.clone_into(&mut self.api_base_url),
            Field::ApiKey => value.clone_into(&mut self.api_key),
            Field::Label => value.clone_into(&mut self.credential_label),
        }
    }
}

/// An [`Edit`] that applies a field edit to the owner `T` and re-renders it.
pub(super) fn edit_handler<T: 'static>(
    cx: &mut Context<T>,
    apply: fn(&mut T, Field, &str),
) -> Edit {
    let entity = cx.entity();
    Rc::new(move |field, value, app| {
        entity.update(app, |this, cx| {
            apply(this, field, &value);
            cx.notify();
        });
    })
}

/// What the fields show.
pub(super) struct View<'a> {
    pub(super) catalog: &'a Catalog,
    pub(super) provider: &'a str,
    pub(super) form: &'a CredentialForm,
    pub(super) auth_methods: &'a [String],
    pub(super) show_api_base_url: bool,
    /// The ChatGPT sign-in card, shown for `chatgpt_oauth`.
    pub(super) chatgpt: Option<AnyElement>,
}

fn text_field(id: &'static str, label: &'static str, input: Input) -> AnyElement {
    SettingsField::new(label)
        .control(input)
        .setting_id(id)
        .into_any_element()
}

fn input(id: &'static str, value: &str, edit: &Edit, field: Field) -> Input {
    let edit = edit.clone();
    Input::new(id)
        .value(value.to_owned())
        .on_change(move |value, _, app| edit(field, value.to_owned().into(), app))
}

fn auth_select(view: &View, edit: &Edit, words: &Words) -> AnyElement {
    let options = view
        .auth_methods
        .iter()
        .map(|method| {
            let label = if method == CHATGPT_OAUTH {
                words.chatgpt_oauth
            } else {
                words.api_key_auth
            };
            SettingsOption::new(method.clone(), label)
        })
        .collect();
    let edit = edit.clone();
    SettingsSelect::new(
        "hosted-auth-method",
        words.auth_method,
        view.form.auth_method.clone(),
    )
    .options(options)
    .on_change(move |value, _, app| edit(Field::AuthMethod, value.clone(), app))
    .into_any_element()
}

fn credential_select(view: &View, edit: &Edit, words: &Words) -> AnyElement {
    let mut options: Vec<SettingsOption> = view
        .catalog
        .credentials(view.provider)
        .iter()
        .map(|credential| {
            SettingsOption::new(
                credential.id.clone(),
                format!("{} ({})", credential.label, credential.masked_value),
            )
        })
        .collect();
    options.push(SettingsOption::new(NEW_CREDENTIAL_ID, words.new_credential));
    let value = if view.form.credential_id.is_empty() {
        SharedString::from(NEW_CREDENTIAL_ID)
    } else {
        view.form.credential_id.clone()
    };
    let edit = edit.clone();
    SettingsSelect::new("hosted-credential", words.credential, value)
        .options(options)
        .on_change(move |value, _, app| edit(Field::Credential, value.clone(), app))
        .into_any_element()
}

/// The API key fields: a saved credential (its masked key) or a new one.
fn key_fields(view: &View, edit: &Edit, words: &Words) -> Vec<AnyElement> {
    let credentials = view.catalog.credentials(view.provider);
    let selected = credentials
        .iter()
        .find(|credential| credential.id.as_str() == &*view.form.credential_id);
    let show_new = &*view.form.credential_id == NEW_CREDENTIAL_ID || credentials.is_empty();
    let mut fields = vec![credential_select(view, edit, words)];
    if let Some(credential) = selected.filter(|_| !show_new) {
        let masked = Input::new("hosted-api-key-masked")
            .value(credential.masked_value.clone())
            .disabled();
        fields.push(text_field("hosted-api-key-masked", words.api_key, masked));
    }
    if show_new {
        let label = input(
            "hosted-credential-label",
            &view.form.credential_label,
            edit,
            Field::Label,
        );
        fields.push(text_field(
            "hosted-credential-label",
            words.credential_label,
            label,
        ));
        let key = input("hosted-api-key", &view.form.api_key, edit, Field::ApiKey).masked();
        fields.push(text_field("hosted-api-key", words.api_key, key));
    }
    fields
}

/// `HostedCredentialFields`
pub(super) fn fields(mut view: View, edit: &Edit, words: &Words) -> Vec<AnyElement> {
    let mut out = Vec::new();
    if view.auth_methods.len() > 1 {
        out.push(auth_select(&view, edit, words));
    }
    if view.show_api_base_url {
        let url = input(
            "hosted-api-base-url",
            &view.form.api_base_url,
            edit,
            Field::BaseUrl,
        );
        out.push(text_field("hosted-api-base-url", words.api_base_url, url));
    }
    if &*view.form.auth_method == API_KEY {
        out.extend(key_fields(&view, edit, words));
    }
    if &*view.form.auth_method == CHATGPT_OAUTH
        && let Some(card) = view.chatgpt.take()
    {
        out.push(card);
    }
    out
}
