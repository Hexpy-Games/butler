//! `ImageModelAddPage.tsx`, `HostedImageModelForm` and `CustomImageModelForm.tsx`.
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::Justify;
use butler_ds::ui::text::Input;
use butler_ds::ui::toast::{Toast, ToastId};
use butler_shell_client::Error;
use gpui::{
    AnyElement, AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render,
    SharedString, Window,
};
use serde::Deserialize;
use serde_json::json;

use super::super::super::{ModelRoute, Navigate};
use super::super::catalog::{API_KEY, Catalog, NEW_CREDENTIAL_ID};
use super::super::copy::words;
use super::super::credentials::{self, CredentialForm, edit_handler};
use super::super::hosted;
use super::super::image_state::{CUSTOM_IMAGE, ImageModel, ImageSettings, ImageSettingsState};
use super::super::notify;
use crate::ui::i18n::settings::words as frame_words;
use crate::ui::settings::SectionCtx;
use crate::ui::settings::state::fetch;

#[derive(Default)]
struct CustomForm {
    name: String,
    endpoint: String,
    model: String,
    key: String,
}

#[derive(Deserialize)]
struct SavedCredential {
    credential: CredentialId,
}

#[derive(Deserialize)]
struct CredentialId {
    id: String,
}

pub(super) struct ImageForm {
    ctx: SectionCtx,
    navigate: Navigate,
    state: Entity<ImageSettingsState>,
    provider: String,
    model_ref: String,
    credentials: CredentialForm,
    custom: CustomForm,
    initialized: bool,
    busy: bool,
    toast: Option<ToastId>,
}

impl ImageForm {
    pub(super) fn new(
        ctx: SectionCtx,
        navigate: Navigate,
        provider: String,
        cx: &mut Context<Self>,
    ) -> Self {
        let state = ImageSettingsState::shared(cx);
        cx.observe(&state, |_, _, cx| cx.notify()).detach();
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        Self {
            ctx,
            navigate,
            state,
            provider,
            model_ref: String::new(),
            credentials: CredentialForm::new(),
            custom: CustomForm::default(),
            initialized: false,
            busy: false,
            toast: None,
        }
    }

    /// `CustomImageModelForm.tsx`: every custom field is disabled during its save.
    fn custom_field(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let copy = words(Ds::get(cx).lang());
        let (id, label, value) = match index {
            0 => ("custom-image-name", copy.name, &self.custom.name),
            1 => (
                "custom-image-endpoint",
                copy.endpoint_url,
                &self.custom.endpoint,
            ),
            2 => ("custom-image-model", copy.model_id, &self.custom.model),
            _ => ("custom-image-key", copy.optional_api_key, &self.custom.key),
        };
        let page = cx.entity();
        let mut input = Input::new(id)
            .value(value.clone())
            .on_change(move |value, _, cx| {
                page.update(cx, |this, cx| {
                    let field = match index {
                        0 => &mut this.custom.name,
                        1 => &mut this.custom.endpoint,
                        2 => &mut this.custom.model,
                        _ => &mut this.custom.key,
                    };
                    value.clone_into(field);
                    cx.notify();
                });
            });
        if index == 3 {
            input = input.masked();
        }
        if self.busy {
            input = input.disabled();
        }
        SettingsField::new(label)
            .setting_id(id)
            .control(input)
            .into_any_element()
    }

    fn custom_fields(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let copy = words(Ds::get(cx).lang());
        let mut fields: Vec<_> = (0..4).map(|i| self.custom_field(i, cx)).collect();
        let navigate = self.navigate.clone();
        let mut cancel = Button::new("custom-image-cancel")
            .variant(Variant::Secondary)
            .text(copy.cancel)
            .on_click(move |_, window, cx| navigate(ModelRoute::ImageManagement, window, cx));
        let mut save = Button::new("custom-image-save")
            .text(copy.save)
            .on_click(cx.listener(|this, _, window, cx| this.save_custom(window, cx)));
        if self.busy {
            cancel = cancel.disabled();
        }
        if self.busy
            || [&self.custom.name, &self.custom.endpoint, &self.custom.model]
                .iter()
                .any(|v| v.trim().is_empty())
        {
            save = save.disabled();
        }
        fields.push(
            button::container(Size::Default)
                .justify(Justify::End)
                .child(cancel)
                .child(save)
                .into_any_element(),
        );
        fields
    }

    /// `HostedImageModelForm` in `ImageModelAddPage.tsx`.
    fn hosted_fields(&mut self, models: &[ImageModel], cx: &mut Context<Self>) -> Vec<AnyElement> {
        let copy = words(Ds::get(cx).lang());
        let catalog = Catalog::read(self.ctx.state.read(cx)).map(Catalog::api_key_only);
        if !self.initialized
            && let Some(catalog) = &catalog
        {
            self.credentials.credential_id = catalog
                .credentials(&self.provider)
                .first()
                .map_or(NEW_CREDENTIAL_ID, |c| c.id.as_str())
                .to_owned()
                .into();
            self.model_ref = models
                .first()
                .map_or_else(String::new, |m| m.model_ref.clone());
            self.initialized = true;
        }
        let summaries: Vec<_> = models.iter().map(|m| m.summary(copy)).collect();
        let refs: Vec<_> = summaries.iter().collect();
        let edit_model = cx.listener(|this, value: &SharedString, _, cx| {
            this.model_ref = value.to_string();
            cx.notify();
        });
        let mut fields = vec![
            hosted::model_select(&refs, &self.model_ref, false, cx, edit_model).into_any_element(),
        ];
        if let Some(catalog) = &catalog {
            let methods = [API_KEY.to_owned()];
            let view = credentials::View {
                catalog,
                provider: &self.provider,
                form: &self.credentials,
                auth_methods: &methods,
                show_api_base_url: false,
                chatgpt: None,
            };
            let edit = edit_handler(cx, |this: &mut Self, field, value| {
                this.credentials.set(field, value);
            });
            fields.extend(credentials::fields(view, &edit, copy));
        }
        let mut save = Button::new("image-model-save")
            .text(if self.busy {
                copy.saving
            } else {
                copy.save_add
            })
            .on_click(cx.listener(|this, _, window, cx| this.save_hosted(window, cx)));
        if self.busy
            || self.model_ref.is_empty()
            || (&*self.credentials.credential_id == NEW_CREDENTIAL_ID
                && self.credentials.api_key.trim().is_empty())
        {
            save = save.disabled();
        }
        fields.push(
            button::container(Size::Default)
                .justify(Justify::End)
                .child(save)
                .into_any_element(),
        );
        fields
    }

    fn save_custom(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut body = json!({"display_name": self.custom.name,
            "api_base_url": self.custom.endpoint, "model_id": self.custom.model});
        if !self.custom.key.trim().is_empty() {
            body["api_key"] = json!(self.custom.key);
        }
        self.busy = true;
        cx.notify();
        let name = self.custom.name.clone();
        let window = window.window_handle();
        fetch(
            cx,
            move |client| async move { client.add_custom_image_model(&body).await },
            move |this: &mut Self, result: Result<ImageSettings, Error>, cx| {
                if result.is_ok() {
                    this.custom.key.clear();
                }
                this.saved(result, &name, window, cx);
            },
        );
    }

    /// Create the credential first; its id remains selected if registration fails.
    fn save_hosted(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.busy = true;
        cx.notify();
        let window = window.window_handle();
        let model_ref = self.model_ref.clone();
        let name = self
            .state
            .read(cx)
            .settings
            .as_ref()
            .and_then(|s| s.models.iter().find(|m| m.model_ref == model_ref))
            .map_or_else(String::new, |m| m.display_name.clone());
        if &*self.credentials.credential_id != NEW_CREDENTIAL_ID {
            let credential = self.credentials.credential_id.clone();
            Self::register(&model_ref, name, &credential, window, cx);
            return;
        }
        let body = json!({"provider_id": self.provider, "auth_type": API_KEY,
            "api_key": self.credentials.api_key, "label": self.credentials.credential_label});
        fetch(
            cx,
            move |client| async move { client.upsert_provider_credential(&body).await },
            move |this: &mut Self, result: Result<SavedCredential, Error>, cx| match result {
                Ok(saved) => {
                    this.ctx.reload_catalog(cx);
                    this.credentials.credential_id = saved.credential.id.clone().into();
                    this.credentials.api_key.clear();
                    Self::register(&model_ref, name, &saved.credential.id, window, cx);
                }
                Err(_) => this.failed(cx),
            },
        );
    }

    fn register(
        model_ref: &str,
        name: String,
        credential_id: &str,
        window: gpui::AnyWindowHandle,
        cx: &mut Context<Self>,
    ) {
        let body = json!({"model_ref": model_ref, "credential_id": credential_id});
        fetch(
            cx,
            move |client| async move { client.register_image_model(&body).await },
            move |this: &mut Self, result: Result<ImageSettings, Error>, cx| {
                this.saved(result, &name, window, cx);
            },
        );
    }

    fn failed(&mut self, cx: &mut Context<Self>) {
        self.busy = false;
        let text = frame_words(Ds::get(cx).lang()).save_failed;
        notify(&mut self.toast, Toast::error(text), cx);
    }

    fn saved(
        &mut self,
        result: Result<ImageSettings, Error>,
        name: &str,
        window: gpui::AnyWindowHandle,
        cx: &mut Context<Self>,
    ) {
        self.busy = false;
        match result {
            Ok(settings) => {
                self.state.update(cx, |state, cx| state.set(settings, cx));
                let text = (words(Ds::get(cx).lang()).registered_status)(name);
                notify(&mut self.toast, Toast::success(text), cx);
                let navigate = self.navigate.clone();
                cx.defer(move |cx| {
                    let _ = cx.update_window(window, |_, window, cx| {
                        navigate(ModelRoute::ImageManagement, window, cx);
                    });
                });
            }
            Err(_) => self.failed(cx),
        }
    }
}

impl Render for ImageForm {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let fields = if self.provider == CUSTOM_IMAGE {
            self.custom_fields(cx)
        } else {
            let settings = self.state.read(cx).settings.clone();
            let available: Vec<_> = settings
                .as_ref()
                .map_or(&[][..], |s| s.models.as_slice())
                .iter()
                .filter(|m| {
                    m.provider_id == self.provider
                        && !settings
                            .as_ref()
                            .is_some_and(|s| s.registered.contains(&m.model_ref))
                })
                .cloned()
                .collect();
            self.hosted_fields(&available, cx)
        };
        butler_ds::ui::blocks::settings_field::SettingsFieldGroup::new().children(fields)
    }
}
