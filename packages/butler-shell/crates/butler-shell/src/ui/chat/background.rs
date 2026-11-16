//! `useConversationWallpaper` for a conversation with messages: the `conversation_background`
//! setting's source behind the conversation, under the theme's paper.
use butler_ds::ui::blocks::scope;
use butler_ds::ui::blocks::wallpaper::{
    Wallpaper, WallpaperHost, WallpaperImage, WallpaperSource, drifts,
};
use gpui::{App, IntoElement, RenderOnce, SharedString, Window, div};
use serde_json::Value;

use super::empty::source::{parse_source, wallpaper_picture};
use super::empty::{blur, day_phase, power};
use crate::ui::composer::card_rect;
use crate::ui::shell::AppSettings;
use crate::ui::source::agent::Jobs;

/// The decoded picture of the asset it was loaded for.
#[derive(Default)]
struct Picture {
    asset: Option<SharedString>,
    picture: Option<WallpaperImage>,
}

/// The decoded picture of an image source, loaded once per asset; never the previous asset's.
pub(in crate::ui::chat) fn picture(
    id: &'static str,
    source: &WallpaperSource,
    window: &mut Window,
    cx: &mut App,
) -> Option<WallpaperImage> {
    let WallpaperSource::Image { asset, .. } = source else {
        return None;
    };
    let state = window.use_keyed_state(id, cx, |_, _| Picture::default());
    if state.read(cx).asset.as_ref() != Some(asset) {
        state.update(cx, |loaded, _| {
            *loaded = Picture {
                asset: Some(asset.clone()),
                picture: None,
            };
        });
        let job = {
            let source = source.clone();
            Jobs::run(cx, move |client| async move {
                wallpaper_picture(&client, &source).await
            })
        };
        let state = state.clone();
        let asset = asset.clone();
        cx.spawn(async move |cx| {
            let Some(picture) = job.await else { return };
            state.update(cx, |loaded, cx| {
                if loaded.asset.as_ref() == Some(&asset) {
                    loaded.picture = picture;
                    cx.notify();
                }
            });
        })
        .detach();
    }
    let loaded = state.read(cx);
    if loaded.asset.as_ref() == Some(asset) {
        loaded.picture.clone()
    } else {
        None
    }
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
        let picture = picture("conversation-background-picture", &source, window, cx);
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
        if let Some(vars) = scope::conversation(cx) {
            wallpaper =
                wallpaper.column(vars.column_left, vars.column_left + vars.column_width, 0.);
        }
        wallpaper.into_any_element()
    }
}
