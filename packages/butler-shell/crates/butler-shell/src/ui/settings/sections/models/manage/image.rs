//! `ImageModelsSettings.tsx`, `ImageCredentialForm.tsx` and `components/images/{imageApi,
//! imageSettingsState}.ts`: the image model, its API key and default quality.
use std::rc::Rc;

use butler_ds::ui::blocks::settings_field::{SettingsField, SettingsFieldGroup};
use butler_ds::ui::button::Button;
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{Toast, ToastId};
use butler_shell_client::Error;
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render,
    SharedString, Window,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::catalog::{API_KEY, Catalog};
use super::copy::{Words, words};
use super::credentials::{self, CredentialForm, Field, edit_handler};
use super::notify;
use crate::ui::i18n::settings::words as frame_words;
use crate::ui::settings::SectionCtx;
use crate::ui::settings::controls::{SettingsOption, SettingsSelect, provider_mark};
use crate::ui::settings::state::fetch;

/// Runs once a credential is saved, with its id.
type OnSaved = Rc<dyn Fn(String, &mut App)>;

/// `ImageSelection`
#[derive(Clone, Deserialize)]
struct Selection {
    model_ref: String,
    credential_id: Option<String>,
    default_quality: String,
}

#[derive(Deserialize)]
struct ImageCredential {
    id: String,
    label: String,
    masked_value: String,
    selectable: bool,
}

/// `ImageModel`
#[derive(Deserialize)]
struct ImageModel {
    model_ref: String,
    display_name: String,
    provider_id: String,
    provider_label: String,
    qualities: Vec<String>,
    default_quality: String,
    credentials: Vec<ImageCredential>,
}

/// `ImageSettings`
#[derive(Deserialize)]
struct ImageSettings {
    selected: Option<Selection>,
    models: Vec<ImageModel>,
}

/// `ImageModelsSettings`
pub(crate) struct ImageModels {
    ctx: SectionCtx,
    settings: Option<ImageSettings>,
    /// `draft`: the model picked while it has no key yet.
    draft: Option<String>,
    busy: bool,
    toast: Option<ToastId>,
    /// `ImageCredentialForm`, keyed by the provider it is for.
    key_form: Option<(String, Entity<ImageKeyForm>)>,
}

impl ImageModels {
    pub(crate) fn new(ctx: SectionCtx, _: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        let page = Self {
            ctx,
            settings: None,
            draft: None,
            busy: false,
            toast: None,
            key_form: None,
        };
        Self::refresh(cx);
        page
    }

    /// `refreshImageSettings`
    fn refresh(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.get_image_model_settings().await },
            |this: &mut Self, result: Result<ImageSettings, Error>, cx| match result {
                Ok(settings) => this.settings = Some(settings),
                Err(_) => this.save_failed(cx),
            },
        );
    }

    fn save_failed(&mut self, cx: &mut Context<Self>) {
        let text = frame_words(Ds::get(cx).lang()).save_failed;
        notify(&mut self.toast, Toast::error(text), cx);
    }

    /// `save`: PUT the selection, or `{selected: null}` to turn images off.
    fn save(&mut self, selection: Option<Value>, cx: &mut Context<Self>) {
        self.busy = true;
        cx.notify();
        let body = selection.unwrap_or_else(|| json!({ "selected": null }));
        fetch(
            cx,
            move |client| async move { client.update_image_model_settings(&body).await },
            |this: &mut Self, result: Result<ImageSettings, Error>, cx| {
                this.busy = false;
                match result {
                    Ok(settings) => {
                        this.settings = Some(settings);
                        this.draft = None;
                    }
                    Err(_) => this.save_failed(cx),
                }
            },
        );
    }

    /// `choose`: "off", or a model with its first usable key.
    fn choose(&mut self, model_ref: &str, cx: &mut Context<Self>) {
        if model_ref == "off" {
            self.save(None, cx);
            return;
        }
        let Some(next) = self
            .settings
            .as_ref()
            .and_then(|s| s.models.iter().find(|m| m.model_ref == model_ref))
        else {
            return;
        };
        let key = next
            .credentials
            .iter()
            .find(|c| c.selectable)
            .map(|c| c.id.clone());
        let default_quality = next.default_quality.clone();
        self.draft = Some(model_ref.to_owned());
        cx.notify();
        if let Some(id) = key {
            self.save(
                Some(selection(model_ref, Some(id.as_str()), &default_quality)),
                cx,
            );
        }
    }

    /// The key the image key form saved: select it for the model being set up.
    fn key_saved(&mut self, credential_id: &str, cx: &mut Context<Self>) {
        let Some(settings) = self.settings.as_ref() else {
            return;
        };
        let model_ref = self.model_ref(settings);
        if let Some(model) = settings.models.iter().find(|m| m.model_ref == model_ref) {
            let value = selection(
                &model.model_ref,
                Some(credential_id),
                &model.default_quality,
            );
            self.save(Some(value), cx);
        }
    }

    /// `modelRef`: the draft, else the saved model, else "off".
    fn model_ref(&self, settings: &ImageSettings) -> String {
        self.draft
            .clone()
            .or_else(|| settings.selected.as_ref().map(|s| s.model_ref.clone()))
            .unwrap_or_else(|| "off".to_owned())
    }

    /// The key form for `provider`, kept while the provider stays.
    fn key_form_for(&mut self, provider: &str, cx: &mut Context<Self>) -> Entity<ImageKeyForm> {
        if let Some((key, form)) = &self.key_form
            && key == provider
        {
            return form.clone();
        }
        let page = cx.entity();
        let on_saved: OnSaved = Rc::new(move |id, app| {
            page.update(app, |this, cx| this.key_saved(&id, cx));
        });
        let (ctx, provider_id) = (self.ctx.clone(), provider.to_owned());
        let form = cx.new(|cx| ImageKeyForm::new(ctx, provider_id, on_saved, cx));
        self.key_form = Some((provider.to_owned(), form.clone()));
        form
    }

    /// The model select: "off" and every image model, grouped by provider.
    fn model_select(
        &self,
        settings: Option<&ImageSettings>,
        model_ref: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let copy = words(Ds::get(cx).lang());
        let mut options = vec![SettingsOption::new("off", copy.image_off)];
        for model in settings.map_or(&[][..], |s| s.models.as_slice()) {
            let provider_id = model.provider_id.clone();
            let mut option =
                SettingsOption::new(model.model_ref.clone(), model.display_name.clone());
            option.group = Some(model.provider_label.clone().into());
            option.icon = Some(Rc::new(move || provider_mark(&provider_id, None, false)));
            options.push(option);
        }
        SettingsSelect::new("image-model", copy.model, model_ref.to_owned())
            .options(options)
            .disabled(self.busy || settings.is_none())
            .on_change(cx.listener(|this, value: &SharedString, _, cx| this.choose(value, cx)))
            .into_any_element()
    }

    /// The key, key form and quality selects of the chosen model.
    fn model_fields(
        &mut self,
        model: &ImageModel,
        selected: Option<&Selection>,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let copy = words(Ds::get(cx).lang());
        let credential = selected
            .and_then(|s| s.credential_id.clone())
            .unwrap_or_default();
        let quality = selected
            .map_or(&model.default_quality, |s| &s.default_quality)
            .clone();
        let keys = model
            .credentials
            .iter()
            .map(|c| {
                let mut option = SettingsOption::new(c.id.clone(), c.label.clone());
                option.description = (!c.masked_value.is_empty())
                    .then(|| SharedString::from(c.masked_value.clone()));
                option.disabled = !c.selectable;
                option.disabled_reason = (!c.selectable).then(|| copy.api_key_only.into());
                option
            })
            .collect();
        let (key_model, key_quality) = (model.model_ref.clone(), quality.clone());
        let pick_key = SettingsSelect::new("image-credential", copy.api_key, credential.clone())
            .options(keys)
            .disabled(self.busy)
            .on_change(cx.listener(move |this, id: &SharedString, _, cx| {
                this.save(Some(selection(&key_model, Some(&**id), &key_quality)), cx);
            }));
        let qualities = model
            .qualities
            .iter()
            .map(|q| SettingsOption::new(q.clone(), quality_label(q, copy)))
            .collect();
        let (quality_model, quality_key) = (model.model_ref.clone(), credential.clone());
        let pick_quality = SettingsSelect::new("image-quality", copy.default_quality, quality)
            .options(qualities)
            .disabled(self.busy || credential.is_empty())
            .on_change(cx.listener(move |this, value: &SharedString, _, cx| {
                let next = selection(&quality_model, Some(quality_key.as_str()), value);
                this.save(Some(next), cx);
            }));
        let mut fields = vec![pick_key.into_any_element()];
        if !model.credentials.iter().any(|c| c.selectable) {
            fields.push(self.key_form_for(&model.provider_id, cx).into_any_element());
        }
        fields.push(pick_quality.into_any_element());
        fields
    }
}

/// `{model_ref, credential_id, default_quality}`
fn selection(model_ref: &str, credential_id: Option<&str>, quality: &str) -> Value {
    json!({ "model_ref": model_ref, "credential_id": credential_id, "default_quality": quality })
}

fn quality_label(quality: &str, copy: &Words) -> SharedString {
    copy.qualities
        .iter()
        .find(|(value, _)| *value == quality)
        .map_or_else(|| quality.to_owned().into(), |(_, label)| (*label).into())
}

impl Render for ImageModels {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Taken for the render so the fields can borrow the settings while `self` builds the
        // key form; put back before returning.
        let settings = self.settings.take();
        let model_ref = settings
            .as_ref()
            .map_or_else(|| "off".to_owned(), |s| self.model_ref(s));
        let mut group =
            SettingsFieldGroup::new().child(self.model_select(settings.as_ref(), &model_ref, cx));
        let model = settings
            .as_ref()
            .and_then(|s| s.models.iter().find(|m| m.model_ref == model_ref));
        if let Some(model) = model {
            let selected = settings
                .as_ref()
                .and_then(|s| s.selected.as_ref())
                .filter(|s| s.model_ref == model_ref);
            group = group.children(self.model_fields(model, selected, cx));
        }
        self.settings = settings;
        group
    }
}

/// `ImageCredentialForm`: the hosted key fields restricted to API-key authentication, and a
/// button that saves the key and hands its id on.
struct ImageKeyForm {
    ctx: SectionCtx,
    provider_id: String,
    form: CredentialForm,
    busy: bool,
    toast: Option<ToastId>,
    on_saved: OnSaved,
}

#[derive(Deserialize)]
struct SavedKey {
    credential: SavedKeyId,
}

#[derive(Deserialize)]
struct SavedKeyId {
    id: String,
}

impl ImageKeyForm {
    fn new(
        ctx: SectionCtx,
        provider_id: String,
        on_saved: OnSaved,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        Self {
            ctx,
            provider_id,
            form: CredentialForm::new(),
            busy: false,
            toast: None,
            on_saved,
        }
    }

    /// POST /credentials; the key leaves the field once sent.
    fn save(&mut self, cx: &mut Context<Self>) {
        self.busy = true;
        cx.notify();
        let body = json!({
            "provider_id": self.provider_id,
            "api_key": self.form.api_key,
            "label": self.form.credential_label,
        });
        fetch(
            cx,
            move |client| async move { client.save_credential(&body).await },
            |this: &mut Self, result: Result<SavedKey, Error>, cx| {
                this.busy = false;
                match result {
                    Ok(saved) => {
                        this.form.api_key.clear();
                        let on_saved = this.on_saved.clone();
                        on_saved(saved.credential.id, cx);
                    }
                    Err(_) => {
                        let text = frame_words(Ds::get(cx).lang()).save_failed;
                        notify(&mut this.toast, Toast::error(text), cx);
                    }
                }
            },
        );
    }
}

impl Render for ImageKeyForm {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let mut group = SettingsFieldGroup::new();
        let methods = [API_KEY.to_owned()];
        if let Some(catalog) = Catalog::read(self.ctx.state.read(cx)) {
            let view = credentials::View {
                catalog: &catalog,
                provider: &self.provider_id,
                form: &self.form,
                auth_methods: &methods,
                show_api_base_url: false,
                chatgpt: None,
            };
            // Only the key and its name are editable here (React passes no-op handlers for
            // the rest).
            let edit = edit_handler(cx, |this: &mut Self, field, value| {
                if matches!(field, Field::ApiKey | Field::Label) {
                    this.form.set(field, value);
                }
            });
            group = group.children(credentials::fields(view, &edit, copy));
        }
        let label = if self.busy {
            copy.saving
        } else {
            copy.save_add
        };
        let mut save = Button::new("image-key-save")
            .text(label)
            .on_click(cx.listener(|this, _, _, cx| this.save(cx)));
        if self.busy || self.form.api_key.trim().is_empty() {
            save = save.disabled();
        }
        group.child(
            SettingsField::new(copy.api_key)
                .control(save)
                .setting_id("image-key-save"),
        )
    }
}
