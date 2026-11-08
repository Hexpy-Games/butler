//! Settings: Appearance (`AppearanceSettings.tsx` and the fields it composes: `TextSizeField`,
//! `ReduceMotionField`, `ComposerFoldField`, `ComposerDecorationSettings`,
//! `ConversationOverlayControl`, `ConversationBackgroundSettings`, `MainScreenThemeSettings`).
//! Theme and text size take effect through the frame's `apply_settings`.
mod copy;
mod sections;

use std::time::Duration;

use gpui::{AnyView, App, AppContext as _, Context, IntoElement, Render, Window};
use serde::Deserialize;
use serde_json::json;

use butler_ds::ui::blocks::settings_section::SettingsPage;
use butler_ds::ui::context::Ds;

use crate::ui::settings::SectionCtx;
use crate::ui::settings::state::Save;

pub(crate) fn page(ctx: SectionCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| AppearancePage::new(ctx, window, cx)).into()
}

/// Trailing wait before the overlay slider's value is written: a drag saves once (React saves
/// on pointer release, which the DS Slider does not report).
const OVERLAY_SAVE_DELAY: Duration = Duration::from_millis(300);

/// The settings Appearance reads (`useSettingsUIStore.draft`).
#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct Slice {
    pub(super) appearance_theme: Option<String>,
    pub(super) text_size: Option<String>,
    pub(super) translucent_sidebar: bool,
    pub(super) show_thinking: bool,
    pub(super) reduce_motion: bool,
    pub(super) collapse_message_box: Option<bool>,
    pub(super) wallpaper: Option<Wallpaper>,
    pub(super) conversation_background: Option<Background>,
    pub(super) composer_decoration: Option<Decoration>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct Source {
    pub(super) kind: String,
    pub(super) module: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Wallpaper {
    pub(super) source: Source,
    pub(super) motion: String,
    pub(super) pause_on_battery: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct Background {
    pub(super) source: Source,
    pub(super) overlay: f64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct Decoration {
    pub(super) theme: String,
    pub(super) character: bool,
}

struct AppearancePage {
    ctx: SectionCtx,
    /// `ConversationOverlayControl`'s local preview of the slider.
    preview: Option<f64>,
    /// Counts slider edits so only the last one writes.
    edits: u64,
    /// The preview has been written; it ends when that save does.
    committed: bool,
}

impl AppearancePage {
    fn new(ctx: SectionCtx, _: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&ctx.state, |this, state, cx| {
            if this.committed && !state.read(cx).saving() {
                this.preview = None;
                this.committed = false;
            }
            cx.notify();
        })
        .detach();
        Self {
            ctx,
            preview: None,
            edits: 0,
            committed: false,
        }
    }

    /// The slider moved: show it at once and write once the drag pauses.
    fn preview_overlay(&mut self, value: f64, cx: &mut Context<Self>) {
        self.preview = Some(value);
        self.committed = false;
        self.edits += 1;
        let edit = self.edits;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(OVERLAY_SAVE_DELAY).await;
            let _ = this.update(cx, |this, cx| {
                if this.edits == edit {
                    this.commit_overlay(cx);
                }
            });
        })
        .detach();
    }

    fn commit_overlay(&mut self, cx: &mut Context<Self>) {
        let Some(overlay) = self.preview else { return };
        self.committed = true;
        let patch = json!({ "conversation_background": { "overlay": overlay.round() } });
        self.ctx.save(patch, Save::default(), cx);
    }
}

impl Render for AppearancePage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let page = SettingsPage::new().labels(SectionCtx::labels(cx));
        let Some(slice) = self.ctx.state.read(cx).slice::<Slice>() else {
            return page;
        };
        let words = copy::words(Ds::get(cx).lang());
        let entity = cx.entity();
        page.section(sections::theme(&self.ctx, &slice, words))
            .section(sections::home_screen(&self.ctx, &slice, words))
            .section(sections::conversation(
                &self.ctx,
                &slice,
                words,
                self.preview,
                move |value, cx| entity.update(cx, |this, cx| this.preview_overlay(value, cx)),
            ))
            .section(sections::message_box(&self.ctx, &slice, words))
            .section(sections::accessibility(&self.ctx, &slice, words))
    }
}
