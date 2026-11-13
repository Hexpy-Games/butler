//! `components/images/imageSettingsState.ts` and `imageApi.ts`: one image settings store.
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{Toast, ToastId};
use butler_shell_client::Error;
use gpui::{App, AppContext as _, Context, Entity, Global};
use serde::Deserialize;

use super::catalog::CatalogModel;
use super::copy::Words;
use super::notify;
use crate::ui::i18n::settings::words as frame_words;
use crate::ui::settings::state::fetch;

pub(super) const CUSTOM_IMAGE: &str = "custom-image";

/// `ImageSelection` in `imageApi.ts`.
#[derive(Clone, Deserialize)]
pub(super) struct Selection {
    pub(super) model_ref: String,
    pub(super) credential_id: Option<String>,
    pub(super) default_quality: Option<String>,
}

/// `ImageModel` in `imageApi.ts`.
#[derive(Clone, Deserialize)]
pub(super) struct ImageModel {
    pub(super) model_ref: String,
    pub(super) display_name: String,
    pub(super) provider_id: String,
    pub(super) provider_label: String,
    pub(super) qualities: Vec<String>,
    pub(super) default_quality: Option<String>,
    pub(super) credential_id: Option<String>,
}

impl ImageModel {
    /// `imageModelSummary` in `ImageModelManagementPage.tsx`.
    pub(super) fn summary(&self, copy: &Words) -> CatalogModel {
        CatalogModel {
            provider_id: self.provider_id.clone(),
            provider_label: if self.provider_id == CUSTOM_IMAGE {
                copy.custom.to_owned()
            } else {
                self.provider_label.clone()
            },
            model_id: self
                .model_ref
                .split_once('/')
                .map_or("", |(_, id)| id)
                .to_owned(),
            model_ref: self.model_ref.clone(),
            display_name: Some(self.display_name.clone()),
            ..Default::default()
        }
    }
}

/// `ImageSettings` in `imageApi.ts`.
#[derive(Clone, Deserialize)]
pub(super) struct ImageSettings {
    pub(super) selected: Option<Selection>,
    pub(super) models: Vec<ImageModel>,
    pub(super) registered: Vec<String>,
}

struct ImageSettingsGlobal(Entity<ImageSettingsState>);
impl Global for ImageSettingsGlobal {}

/// `useImageSettingsState`: shared by the root, management and add pages.
pub(super) struct ImageSettingsState {
    pub(super) settings: Option<ImageSettings>,
    toast: Option<ToastId>,
}

impl ImageSettingsState {
    pub(super) fn shared(cx: &mut App) -> Entity<Self> {
        if let Some(state) = cx.try_global::<ImageSettingsGlobal>() {
            return state.0.clone();
        }
        let state = cx.new(|_| Self {
            settings: None,
            toast: None,
        });
        cx.set_global(ImageSettingsGlobal(state.clone()));
        state
    }

    /// `refreshImageSettings` in `imageSettingsState.ts`.
    pub(super) fn refresh(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.get_image_model_settings().await },
            |this: &mut Self, result: Result<ImageSettings, Error>, cx| match result {
                Ok(settings) => this.set(settings, cx),
                Err(_) => {
                    let text = frame_words(Ds::get(cx).lang()).save_failed;
                    notify(&mut this.toast, Toast::error(text), cx);
                }
            },
        );
    }

    pub(super) fn set(&mut self, settings: ImageSettings, cx: &mut Context<Self>) {
        self.settings = Some(settings);
        cx.notify();
    }
}
