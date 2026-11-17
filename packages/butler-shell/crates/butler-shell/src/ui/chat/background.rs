//! `useConversationWallpaper` for a conversation with messages: the `conversation_background`
//! setting's source behind the conversation, under the theme's paper.
use std::collections::HashMap;

use butler_ds::ui::blocks::scope;
use butler_ds::ui::blocks::wallpaper::{
    Wallpaper, WallpaperHost, WallpaperImage, WallpaperSource, drifts,
};
use gpui::{App, Global, IntoElement, RenderOnce, SharedString, Window, div};
use serde_json::Value;

use super::empty::source::{global_source, parse_source, wallpaper_picture};
use super::empty::{blur, day_phase, power};
use crate::ui::composer::card_rect;
use crate::ui::shell::AppSettings;
use crate::ui::source::agent::Jobs;

/// The decoded pictures of the image sources in use (`imageCache.ts`): one per asset, shared by
/// every screen. `None` while the asset loads, and after a failed load (not retried while the
/// asset stays in use). In use: the assets the settings name, plus the latest requested asset
/// they do not name (a project's own picture).
#[derive(Default)]
struct Pictures {
    loaded: HashMap<SharedString, Option<WallpaperImage>>,
    /// The latest requested image asset the settings do not name.
    other: Option<SharedString>,
}

impl Global for Pictures {}

/// The assets of the image sources the current settings name: the main wallpaper and the
/// conversation background.
fn named_assets(cx: &App) -> Vec<SharedString> {
    let Some(settings) = AppSettings::get(cx) else {
        return Vec::new();
    };
    [global_source(&settings), setting(&settings).0]
        .into_iter()
        .filter_map(|source| match source {
            WallpaperSource::Image { asset, .. } => Some(asset),
            _ => None,
        })
        .collect()
}

/// `imageCache.ts` `retain`: forgets the pictures no longer in use; a requested asset the
/// settings do not name becomes the kept other asset.
fn retain(requested: Option<&SharedString>, cx: &mut App) {
    let named = named_assets(cx);
    let pictures = cx.default_global::<Pictures>();
    if let Some(asset) = requested.filter(|asset| !named.contains(asset)) {
        pictures.other = Some(asset.clone());
    }
    let other = pictures.other.clone();
    pictures
        .loaded
        .retain(|kept, _| named.contains(kept) || other.as_ref() == Some(kept));
}

/// The decoded picture of an image source, loaded once per asset; never another asset's.
pub(in crate::ui::chat) fn picture(
    source: &WallpaperSource,
    cx: &mut App,
) -> Option<WallpaperImage> {
    let asset = match source {
        WallpaperSource::Image { asset, .. } => Some(asset),
        _ => None,
    };
    retain(asset, cx);
    let asset = asset?;
    if let Some(picture) = cx.default_global::<Pictures>().loaded.get(asset) {
        return picture.clone();
    }
    Jobs::client(cx)?;
    cx.default_global::<Pictures>()
        .loaded
        .insert(asset.clone(), None);
    let job = {
        let source = source.clone();
        Jobs::run(cx, move |client| async move {
            wallpaper_picture(&client, &source).await
        })
    };
    let asset = asset.clone();
    cx.spawn(async move |cx| {
        let answer = job.await;
        cx.update(|cx| {
            let loaded = &mut cx.default_global::<Pictures>().loaded;
            // Only a pending entry: another load may have answered already.
            if !matches!(loaded.get(&asset), Some(None)) {
                return;
            }
            let Some(picture) = answer else {
                // The job never answered (the agent detached): ask again on the next request.
                loaded.remove(&asset);
                return;
            };
            loaded.insert(asset, picture);
            cx.refresh_windows();
        });
    })
    .detach();
    None
}

/// `parseConversationBackgroundSetting`, else `EMPTY_SETTINGS.conversation_background`
/// (constants.ts): the source and the paper overlay in percent.
fn setting(settings: &Value) -> (WallpaperSource, u8) {
    let parsed = settings
        .get("conversation_background")
        .filter(|background| background.is_object())
        .and_then(|background| {
            let source = parse_source(background.get("source")?)?;
            let overlay = match background.get("overlay") {
                None | Some(Value::Null) => 70,
                Some(value) => u8::try_from(value.as_u64()?).ok()?,
            };
            (overlay <= 95 && overlay % 5 == 0).then_some((source, overlay))
        });
    parsed.unwrap_or_else(|| (WallpaperSource::live("butler.riso-print"), 70))
}

/// `useConversationWallpaper`'s background for a conversation that is not empty. It renders
/// inside the conversation shell's scope, which tells it where the message column is.
#[derive(IntoElement)]
pub(crate) struct ConversationBackground;

impl RenderOnce for ConversationBackground {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let Some(settings) = AppSettings::get(cx) else {
            return div().into_any_element();
        };
        let (source, percent) = setting(&settings);
        if source == WallpaperSource::None {
            return div().into_any_element();
        }
        let overlay = match &source {
            WallpaperSource::Image { .. } => f32::from(percent) / 100.,
            WallpaperSource::Live { module, .. } if module != "butler.riso-print" => {
                f32::from(percent) / 100.
            }
            _ => 0.,
        };
        let drifts = drifts(&source);
        let power = power::state(window, cx);
        let picture = picture(&source, cx);
        let mut wallpaper = Wallpaper::new(source)
            .motion(power.on_battery)
            .host(WallpaperHost {
                on_battery: power.on_battery,
                constrained: power.constrained,
                blur: if drifts { blur::level(window, cx) } else { 0 },
            })
            .content_rect2(card_rect(cx))
            .day_phase(day_phase())
            .paper_overlay(overlay);
        if let Some(picture) = picture {
            wallpaper = wallpaper.picture(picture);
        }
        // Electron sends no column before the shell has laid out.
        if let Some(vars) = scope::conversation(cx).filter(|vars| vars.column_width > 0.) {
            wallpaper = wallpaper.column(vars.column_left, vars.column_right, 0.);
        }
        wallpaper.into_any_element()
    }
}
