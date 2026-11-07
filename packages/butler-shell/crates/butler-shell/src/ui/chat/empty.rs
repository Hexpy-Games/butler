//! The new chat: `EmptyState`, `EpicEmptyState`, `emptyStateSuggestions`, `mainScreenTheme` and
//! `useConversationWallpaper` (poster stills on WallpaperStage).
mod source;

use std::sync::{Arc, OnceLock};

use butler_ds::ui::blocks::prompt_suggestion_list::{PromptSuggestionItem, PromptSuggestionList};
use butler_ds::ui::blocks::wallpaper::{Wallpaper, WallpaperSource, bundled_image};
use butler_ds::ui::blocks::wallpaper_stage::WallpaperStage;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::layout::{Box, Cross, Justify, MaxWidth, Space, Stack, WithItem as _};
use butler_ds::ui::typo::{TextAlign, Tone, Typo, Wrap};
use gpui::{
    AnyElement, App, Entity, Image, ImageFormat, ImageSource, IntoElement as _, ParentElement as _,
    Styled as _, Window, img,
};

use self::source::{EpicInfo, Resolved, Want, fetch, resolve};
use super::send_message;
use crate::ui::composer::fill_composer_with_template;
use crate::ui::i18n::new_chat::{epic_caption, general_suggestions, project_suggestions, words};
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::NewChatSuggestion;

/// Where the new chat opens.
#[derive(Clone, Copy, Default)]
pub(crate) struct EmptyCtx<'a> {
    pub(crate) project_id: Option<&'a str>,
    pub(crate) epic_id: Option<&'a str>,
}

/// What the screen has loaded for one place and language (the effect's result in `EmptyState`).
#[derive(Default, Clone)]
struct Loaded {
    key: Option<String>,
    resolved: Option<Resolved>,
}

/// `butlerMarkDarkSrc` / `butlerMarkLightSrc`.
fn mark(dark: bool) -> Arc<Image> {
    static MARKS: OnceLock<(Arc<Image>, Arc<Image>)> = OnceLock::new();
    let (light, white) = MARKS.get_or_init(|| {
        (
            bundled_image(
                ImageFormat::Png,
                include_bytes!("../../../../butler-ds/assets/brand/butler-mark.png"),
            ),
            bundled_image(
                ImageFormat::Png,
                include_bytes!("../../../../butler-ds/assets/brand/butler-mark-white.png"),
            ),
        )
    });
    Arc::clone(if dark { white } else { light })
}

/// `EmptyState`'s effect: reads the briefing, the epic and the wallpaper again when the place
/// or the language changes.
fn load(state: &Entity<Loaded>, ctx: &EmptyCtx<'_>, lang: Lang, cx: &mut App) {
    let key = format!(
        "{}|{}|{}",
        ctx.project_id.unwrap_or_default(),
        ctx.epic_id.unwrap_or_default(),
        matches!(lang, Lang::Ko)
    );
    if state.read(cx).key.as_deref() == Some(key.as_str()) {
        return;
    }
    state.update(cx, |loaded, _| loaded.key = Some(key.clone()));
    let project_id = ctx.project_id.map(str::to_owned);
    let want = Want {
        project_id: project_id.clone(),
        epic_id: ctx.epic_id.map(str::to_owned),
        briefing: ctx.epic_id.is_none(),
    };
    let job = Jobs::run(cx, move |client| fetch(client, want));
    let state = state.clone();
    cx.spawn(async move |cx| {
        let Some(fetched) = job.await else { return };
        let resolved = resolve(fetched, project_id.as_deref());
        state.update(cx, |loaded, cx| {
            if loaded.key.as_deref() == Some(key.as_str()) {
                loaded.resolved = Some(resolved);
                cx.notify();
            }
        });
    })
    .detach();
}

/// The new-chat screen behind the composer.
pub(crate) fn empty_state(ctx: EmptyCtx<'_>, window: &mut Window, cx: &mut App) -> AnyElement {
    let lang = Ds::get(cx).lang();
    let state = window.use_keyed_state("new-chat-empty", cx, |_, _| Loaded::default());
    load(&state, &ctx, lang, cx);
    let resolved = state.read(cx).resolved.clone();
    let wallpaper = resolved
        .as_ref()
        .map_or(WallpaperSource::None, |resolved| resolved.wallpaper.clone());
    let content = match (ctx.epic_id, resolved.as_ref().and_then(|r| r.epic.clone())) {
        (Some(_), epic) => epic.map(|epic| epic_empty_state(&epic, lang)),
        (None, _) => Some(prompt_list(&ctx, resolved.as_ref(), lang, cx)),
    };
    WallpaperStage::new()
        .wallpaper(Wallpaper::new(wallpaper))
        .children(content)
        .into_any_element()
}

/// `EpicEmptyState`.
fn epic_empty_state(epic: &EpicInfo, lang: Lang) -> AnyElement {
    let group = epic
        .group
        .clone()
        .unwrap_or_else(|| words(lang).backlog.to_owned());
    Stack::new()
        .fill()
        .justify(Justify::Center)
        .cross(Cross::Center)
        .child(
            Box::new()
                .padding(Space::Xl)
                .max_width(MaxWidth::Full)
                .child(
                    Typo::h1(epic.title.clone())
                        .align(TextAlign::Center)
                        .wrap(Wrap::Anywhere),
                )
                .child(
                    Typo::caption(epic_caption(lang, &group))
                        .align(TextAlign::Center)
                        .tone(Tone::Secondary),
                ),
        )
        .into_any_element()
}

/// `fillComposerWithTemplate` or a send, by the suggestion's kind.
fn select(suggestion: &NewChatSuggestion, cx: &mut App) {
    if suggestion.template {
        fill_composer_with_template(&suggestion.text, cx);
    } else {
        send_message(&suggestion.text, cx);
    }
}

/// `EmptyState`'s `PromptSuggestionList`.
fn prompt_list(
    ctx: &EmptyCtx<'_>,
    resolved: Option<&Resolved>,
    lang: Lang,
    cx: &mut App,
) -> AnyElement {
    let copy = words(lang);
    let briefing = resolved.and_then(|resolved| resolved.briefing.as_ref());
    let suggestions: Vec<NewChatSuggestion> = match briefing {
        Some(briefing) => briefing.suggestions.clone(),
        None if ctx.project_id.is_some() => {
            let name = resolved.and_then(|r| r.project_name.as_deref());
            project_suggestions(lang, name.unwrap_or_default())
        }
        None => general_suggestions(lang),
    };
    let items = suggestions.into_iter().map(|suggestion| {
        PromptSuggestionItem::new(
            suggestion.id.clone(),
            suggestion.title.clone(),
            suggestion.description.clone(),
            suggestion.text.clone(),
        )
        .on_select(move |_, cx| select(&suggestion, cx))
    });
    let title = briefing.map_or(copy.new_chat, |briefing| briefing.title.as_str());
    let moment = briefing.map_or_else(
        || {
            let now = chrono::Local::now();
            super::user::format_clock(&now, lang, &now)
        },
        |briefing| briefing.moment.clone(),
    );
    let mark = mark(Ds::get(cx).dark());
    let mut list = PromptSuggestionList::new("new-chat", title.to_owned(), items.collect())
        .moment(moment)
        .title_icon(move |_| img(ImageSource::Image(mark.clone())).size_full().into_any_element());
    if let Some(description) = briefing.and_then(|briefing| briefing.description.clone()) {
        list = list.description(description);
    }
    list.into_any_element()
}
