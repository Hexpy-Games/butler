//! `ModelManagementPage.tsx`, `RegisteredModelRow.tsx` and `ModelAuthTag.tsx`: the registered
//! models, each with Edit and Delete.
use butler_ds::ui::blocks::settings_section::{
    SettingsPage, SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_slot::{IconSlot, SlotSize};
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::tag::Tag;
use butler_ds::ui::toast::{Toast, ToastId};
use butler_ds::ui::typo::Typo;
use butler_shell_client::Error;
use gpui::{
    AnyElement, Context, Entity, IntoElement, ParentElement as _, Render, SharedString, Window,
};
use serde_json::Value;

use super::super::{ModelRoute, Navigate};
use super::catalog::{CHATGPT_OAUTH, Catalog, CatalogModel, LOCAL_PROVIDER_ID};
use super::copy::{Words, words};
use super::image_state::{ImageSettings, ImageSettingsState};
use super::notify;
use crate::ui::Icon;
use crate::ui::composer::menus::token_window_label;
use crate::ui::i18n::composer::menus::copy as menus_copy;
use crate::ui::settings::SectionCtx;
use crate::ui::settings::confirm::Request;
use crate::ui::settings::controls::provider_mark;
use crate::ui::settings::state::fetch;

/// `ModelManagementPage.tsx`: chat keeps edit and token captions; image omits both.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Kind {
    Chat,
    Image,
}

/// `ModelManagementPage`
pub(crate) struct ManagementPage {
    ctx: SectionCtx,
    kind: Kind,
    images: Entity<ImageSettingsState>,
    navigate: Navigate,
    /// `busyModelRef`: the model being deleted.
    busy: Option<String>,
    toast: Option<ToastId>,
}

impl ManagementPage {
    pub(crate) fn new(
        ctx: SectionCtx,
        navigate: Navigate,
        kind: Kind,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        let images = ImageSettingsState::shared(cx);
        cx.observe(&images, |_, _, cx| cx.notify()).detach();
        Self {
            ctx,
            kind,
            images,
            navigate,
            busy: None,
            toast: None,
        }
    }

    /// `deleteRegisteredModel`: asks first; declining deletes nothing.
    fn ask_delete(&mut self, model: CatalogModel, cx: &mut Context<Self>) {
        let copy = words(Ds::get(cx).lang());
        let request = Request::new((copy.delete_confirm)(model.name()))
            .title(copy.delete)
            .confirm_label(copy.delete)
            .destructive();
        let page = cx.entity();
        self.ctx.confirm(
            request,
            move |_, app| page.update(app, |this, cx| this.remove(&model, cx)),
            cx,
        );
    }

    fn remove(&mut self, model: &CatalogModel, cx: &mut Context<Self>) {
        self.busy = Some(model.model_ref.clone());
        cx.notify();
        let model_ref = model.model_ref.clone();
        let local = model.provider_id == LOCAL_PROVIDER_ID;
        let image = self.kind == Kind::Image;
        let name = model.name().to_owned();
        fetch(
            cx,
            move |client| async move {
                if image {
                    client.unregister_image_model(&model_ref).await
                } else if local {
                    client.delete_local_model(&model_ref).await
                } else {
                    client.delete_hosted_model(&model_ref).await
                }
            },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                this.busy = None;
                let copy = words(Ds::get(cx).lang());
                match result {
                    Ok(value) => {
                        if image {
                            match serde_json::from_value::<ImageSettings>(value) {
                                Ok(settings) => {
                                    this.images.update(cx, |state, cx| state.set(settings, cx));
                                }
                                Err(_) => {
                                    notify(&mut this.toast, Toast::error(copy.error_delete), cx);
                                    return;
                                }
                            }
                        } else {
                            this.ctx.reload_catalog(cx);
                        }
                        let text = (copy.deleted_status)(&name);
                        notify(&mut this.toast, Toast::success(text), cx);
                    }
                    Err(_) => notify(&mut this.toast, Toast::error(copy.error_delete), cx),
                }
            },
        );
    }

    /// `RegisteredModelRow`
    fn row(&self, model: &CatalogModel, lang: Lang, cx: &mut Context<Self>) -> AnyElement {
        let copy = words(lang);
        let busy = self.busy.as_deref() == Some(model.model_ref.as_str());
        let (edit_model, delete_model) = (model.clone(), model.clone());
        let mut edit = Button::new(SharedString::from(format!(
            "model-edit-{}",
            model.model_ref
        )))
        .variant(Variant::Outline)
        .size(Size::Sm)
        .icon_start(icon(Icon::Pencil, IconSize::Sm, Ds::get(cx)))
        .text(copy.edit)
        .on_click(cx.listener(move |this, _, window, cx| {
            let route = ModelRoute::Edit(edit_model.model_ref.clone().into());
            (this.navigate)(route, window, cx);
        }));
        let mut delete = Button::new(SharedString::from(format!(
            "model-delete-{}",
            model.model_ref
        )))
        .variant(Variant::Outline)
        .size(Size::Sm)
        .icon_start(icon(Icon::Trash2, IconSize::Sm, Ds::get(cx)))
        .text(copy.delete)
        .on_click(cx.listener(move |this, _, _, cx| {
            this.ask_delete(delete_model.clone(), cx);
        }));
        if busy {
            edit = edit.disabled();
            delete = delete.disabled();
        }
        let mut actions = button::container(Size::Sm);
        if self.kind == Kind::Chat {
            actions = actions.child(edit);
        }
        let actions = actions.child(delete);
        Stack::row()
            .justify(Justify::Between)
            .cross(Cross::Center)
            .gap(Space::Md)
            .wrap(true)
            .child(summary(model, lang, self.kind == Kind::Chat))
            .child(actions)
            .into_any_element()
    }
}

/// The mark, the title and the context window and auth tag under it.
fn summary(model: &CatalogModel, lang: Lang, show_token_caption: bool) -> AnyElement {
    let copy = words(lang);
    let mark = IconSlot::new()
        .size(SlotSize::Lg)
        .min_line()
        .child(provider_mark(
            &model.provider_id,
            model.platform.as_deref(),
            false,
        ));
    let title = Typo::panel_section_title(format!("{} / {}", model.provider_label, model.name()));
    let mut details = Stack::new().gap(Space::Xs);
    if show_token_caption {
        details = details.child(Typo::caption(token_window_label(
            model.context_window_tokens,
            menus_copy(lang),
        )));
    }
    let details = details.children(auth_tag(model, copy));
    Stack::row()
        .cross(Cross::Start)
        .gap(Space::Md)
        .child(mark)
        .child(Stack::new().gap(Space::None).child(title).child(details))
        .into_any_element()
}

/// `ModelAuthTag`: none without an `auth_type`.
fn auth_tag(model: &CatalogModel, copy: &Words) -> Option<Tag> {
    let auth_type = model.auth_type.as_deref()?;
    let auth = if auth_type == CHATGPT_OAUTH {
        copy.chatgpt_oauth
    } else {
        copy.api_key_auth
    };
    let label = match model
        .credential_masked_value
        .as_deref()
        .filter(|m| !m.is_empty())
    {
        Some(masked) => (copy.auth_tag)(auth, masked),
        None => auth.to_owned(),
    };
    Some(Tag::new(
        SharedString::from(format!("model-auth-{}", model.model_ref)),
        label,
    ))
}

impl Render for ManagementPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = Ds::get(cx).lang();
        let copy = words(lang);
        let page = SettingsPage::new().labels(SectionCtx::labels(cx));
        let catalog = Catalog::read(self.ctx.state.read(cx));
        let image_models = self.images.read(cx).settings.as_ref().map(|settings| {
            settings
                .models
                .iter()
                .filter(|m| settings.registered.contains(&m.model_ref))
                .map(|m| m.summary(copy))
                .collect::<Vec<_>>()
        });
        let models = if self.kind == Kind::Image {
            image_models.as_deref()
        } else {
            catalog.as_ref().map(|c| c.registered_models.as_slice())
        };
        let state = match models {
            None => SettingsSectionState::Loading,
            Some([]) => SettingsSectionState::Empty,
            Some(_) => SettingsSectionState::Ready,
        };
        let navigate = self.navigate.clone();
        let image = self.kind == Kind::Image;
        let add_route = if image {
            ModelRoute::ImageAdd
        } else {
            ModelRoute::Add
        };
        let add = Button::new("model-add")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .icon_start(icon(Icon::Plus, IconSize::Sm, Ds::get(cx)))
            .text(copy.add_button)
            .on_click(move |_, window, cx| navigate(add_route.clone(), window, cx));
        let rows: Vec<AnyElement> = models
            .unwrap_or_default()
            .iter()
            .map(|model| self.row(model, lang, cx))
            .collect();
        page.section(
            SettingsSection::new(
                if image {
                    "registered-image-models"
                } else {
                    "registered-models"
                },
                SettingsSectionKind::List,
                if image {
                    copy.image_title
                } else {
                    copy.registered_title
                },
            )
            .state(state)
            .empty_message(copy.empty_registered)
            .actions(add)
            .children(rows),
        )
    }
}
