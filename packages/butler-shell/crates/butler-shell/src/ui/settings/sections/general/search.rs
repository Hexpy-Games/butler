//! `SearchProviderFields` and `SearchBehaviorFields` (SearchSettings.tsx,
//! SearchBehaviorFields.tsx, hooks/useSearchSettingUpdate.ts): every write is
//! `{web_search: {[key]: value}}`.
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::blocks::settings_section::SettingsSection;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::text::Input;
use gpui::{App, ElementId, ParentElement as _, SharedString, Window};
use serde_json::{Value, json};

use super::copy::GeneralCopy;
use super::slice::WebSearch;
use super::{form, options, patch, select};
use crate::ui::settings::controls::SettingsSwitch;
use crate::ui::settings::{Save, SectionCtx};

const PARENT: Option<&str> = Some("web_search");

/// The search provider and, for one that reads a key from the environment, the key field.
pub(super) fn provider(
    ctx: &SectionCtx,
    web: &WebSearch,
    copy: &'static GeneralCopy,
    window: &mut Window,
    cx: &mut App,
) -> SettingsSection {
    let [duckduckgo, auto, brave, tavily, openai, chatgpt, disabled] = copy.providers;
    let choices = options(&[
        ("duckduckgo-html", duckduckgo),
        ("auto", auto),
        ("brave", brave),
        ("tavily", tavily),
        ("openai-web-search", openai),
        ("chatgpt-plan-web-search", chatgpt),
        ("disabled", disabled),
    ]);
    let section = form("search-provider", copy.sections[7])
        .description(copy.section_descriptions[2])
        .child(
            select(
                ctx,
                "search-provider",
                copy.search_fields[0],
                &web.provider,
                choices,
                PARENT,
                "provider",
            )
            .description(copy.search_descriptions[0]),
        );
    match &web.api_key_env_var {
        Some(env) if !env.is_empty() => section.child(api_key(ctx, web, env, copy, window, cx)),
        _ => section,
    }
}

/// The API key: typed here, saved with Save, cleared when the provider changes.
fn api_key(
    ctx: &SectionCtx,
    web: &WebSearch,
    env: &str,
    copy: &'static GeneralCopy,
    window: &mut Window,
    cx: &mut App,
) -> SettingsField {
    let id = ElementId::from("search-api-key");
    let draft = window.use_keyed_state((id.clone(), "draft"), cx, |_, _| SharedString::default());
    let seen = window.use_keyed_state((id, "provider"), cx, |_, _| {
        SharedString::from(web.provider.clone())
    });
    if seen.read(cx).as_str() != web.provider {
        seen.update(cx, |seen, _| *seen = web.provider.clone().into());
        draft.update(cx, |draft, _| *draft = SharedString::default());
    }
    let text = draft.read(cx).clone();
    let placeholder = if web.api_key_configured {
        SharedString::from(copy.search_descriptions[1])
    } else {
        SharedString::from(env.to_owned())
    };
    let typed = draft.clone();
    let input = Input::new("search-api-key")
        .masked()
        .placeholder(placeholder)
        .value(text.clone())
        .on_change(move |value, _, cx| {
            typed.update(cx, |draft, cx| {
                *draft = value.to_owned().into();
                cx.notify();
            });
        });
    let ctx = ctx.clone();
    let mut save = Button::new("search-api-key-save")
        .size(Size::Xs)
        .variant(Variant::Outline)
        .text(copy.save)
        .on_click(move |_, _, cx| {
            let key = draft.read(cx).trim().to_owned();
            if key.is_empty() {
                return;
            }
            ctx.save(
                patch(PARENT, "api_key", &Value::from(key)),
                Save::default(),
                cx,
            );
            draft.update(cx, |draft, cx| {
                *draft = SharedString::default();
                cx.notify();
            });
        });
    if text.trim().is_empty() {
        save = save.disabled();
    }
    SettingsField::new(copy.search_fields[1])
        .description((copy.api_key)(env))
        .setting_id("search-api-key")
        .control(
            Stack::row()
                .gap(Space::Sm)
                .wrap(true)
                .child(input)
                .child(save),
        )
}

/// The page reader, search planning and, when planning is on, its depth.
pub(super) fn behavior(
    ctx: &SectionCtx,
    web: &WebSearch,
    copy: &'static GeneralCopy,
) -> SettingsSection {
    let [browser, lightweight, auto, lightpanda, jina, disabled] = copy.readers;
    let readers = options(&[
        ("browser", browser),
        ("lightweight", lightweight),
        ("auto", auto),
        ("lightpanda", lightpanda),
        ("jina-hosted", jina),
        ("disabled", disabled),
    ]);
    let planning_ctx = ctx.clone();
    let planning = SettingsSwitch::new("search-planning", copy.search_fields[3])
        .description(copy.search_descriptions[3])
        .checked(web.planning_enabled)
        .on_change(move |checked, _, cx| {
            let body = patch(PARENT, "planning_enabled", &json!(checked));
            planning_ctx.save(body, Save::default(), cx);
        });
    let mut section = form("search-behavior", copy.sections[8])
        .description(copy.section_descriptions[3])
        .child(
            select(
                ctx,
                "search-reader",
                copy.search_fields[2],
                &web.reader_backend,
                readers,
                PARENT,
                "reader_backend",
            )
            .description(copy.search_descriptions[2]),
        )
        .child(planning);
    if web.planning_enabled {
        let [quick, balanced, deep] = copy.depths;
        let depths = options(&[("quick", quick), ("balanced", balanced), ("deep", deep)]);
        section = section.child(select(
            ctx,
            "search-depth",
            copy.search_fields[4],
            &web.planning_default_depth,
            depths,
            PARENT,
            "planning_default_depth",
        ));
    }
    section
}
