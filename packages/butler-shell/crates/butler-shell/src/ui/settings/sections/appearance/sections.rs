//! The five sections of `AppearanceSettings.tsx`.
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::label::Label;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::segmented_control::{Choice, SegmentedControl};
use butler_ds::ui::slider::Slider;
use gpui::{App, ParentElement as _, Window};
use serde_json::{Value, json};

use super::copy::Words;
use super::{Slice, Source};
use crate::ui::settings::SectionCtx;
use crate::ui::settings::controls::{SettingsOption, SettingsSelect, SettingsSwitch};
use crate::ui::settings::state::Save;

/// A switch's write: `update({ [key]: value }, setSettings)`.
fn toggle(ctx: &SectionCtx, key: &'static str) -> impl Fn(bool, &mut Window, &mut App) + 'static {
    let ctx = ctx.clone();
    move |value, _, cx| ctx.save(json!({ key: value }), Save::default(), cx)
}

/// A switch whose new value shows at once (`setSettings({...settings, key: value})` first).
fn toggle_now(
    ctx: &SectionCtx,
    key: &'static str,
) -> impl Fn(bool, &mut Window, &mut App) + 'static {
    let ctx = ctx.clone();
    move |value, _, cx| {
        ctx.save(
            json!({ key: value }),
            Save {
                optimistic: true,
                silent: false,
            },
            cx,
        );
    }
}

fn nested(ctx: &SectionCtx, patch: Value, cx: &mut App) {
    ctx.save(patch, Save::default(), cx);
}

pub(super) fn theme(ctx: &SectionCtx, slice: &Slice, words: &Words) -> SettingsSection {
    let select_ctx = ctx.clone();
    let size_ctx = ctx.clone();
    let mut section = SettingsSection::new("theme", SettingsSectionKind::Form, words.section_theme)
        // CARVE-OUT(G-wall): `disabledReason` themeFollowsWallpaper while a real-time wallpaper
        // sets light/dark (`appearanceStore.sceneTone`); the wallpaper engine is not ported.
        .child(
            SettingsSelect::new(
                "theme",
                words.theme,
                slice
                    .appearance_theme
                    .as_deref()
                    .unwrap_or("system")
                    .to_owned(),
            )
            .options(vec![
                SettingsOption::new("system", words.system),
                SettingsOption::new("light", words.light),
                SettingsOption::new("dark", words.dark),
            ])
            .on_change(move |value, _, cx| {
                nested(
                    &select_ctx,
                    json!({ "appearance_theme": value.to_string() }),
                    cx,
                );
            }),
        );
    if let Some(size) = slice.text_size.as_deref() {
        let control = SegmentedControl::new("text-size", words.text_size, size.to_owned())
            .options([
                Choice::new("default", words.text_size_default),
                Choice::new("large", words.text_size_large),
                Choice::new("larger", words.text_size_larger),
            ])
            .on_value_change(move |value, _, cx| {
                size_ctx.save(
                    json!({ "text_size": value }),
                    Save {
                        optimistic: true,
                        silent: true,
                    },
                    cx,
                );
            });
        section = section.child(SettingsField::new(words.text_size).control(control));
    }
    section.child(
        SettingsSwitch::new("translucent-sidebar", words.translucent_sidebar)
            .checked(slice.translucent_sidebar)
            .on_change(toggle(ctx, "translucent_sidebar")),
    )
}

/// `MainScreenThemeSettings`: the wallpaper picker, then motion and battery.
pub(super) fn home_screen(ctx: &SectionCtx, slice: &Slice, words: &Words) -> SettingsSection {
    let section = SettingsSection::new(
        "home-screen",
        SettingsSectionKind::Form,
        words.section_home_screen,
    )
    .description(words.home_screen_description);
    // CARVE-OUT(G-wall): the `main-screen-wallpaper` field (WallpaperPicker: tiles, image
    // upload and delete, module import and delete, source save).
    let Some(wallpaper) = slice.wallpaper.as_ref().filter(|w| w.source.kind != "none") else {
        return section;
    };
    let reduced = slice.reduce_motion;
    let auto = wallpaper.motion == "auto";
    let motion_ctx = ctx.clone();
    let mut motion = SettingsSwitch::new("main-screen-motion", words.wallpaper_motion)
        .description(words.wallpaper_motion_description)
        .checked(!reduced && auto)
        .on_change(move |on, _, cx| {
            let motion = if on { "auto" } else { "paused" };
            nested(
                &motion_ctx,
                json!({ "wallpaper": { "motion": motion } }),
                cx,
            );
        });
    if reduced {
        motion = motion.disabled_reason(words.wallpaper_still);
    }
    let section = section.child(motion);
    if !auto || reduced {
        return section;
    }
    let battery_ctx = ctx.clone();
    section.child(
        SettingsSwitch::new("main-screen-battery", words.pause_on_battery)
            .description(words.pause_on_battery_description)
            .checked(wallpaper.pause_on_battery)
            .on_change(move |on, _, cx| {
                nested(
                    &battery_ctx,
                    json!({ "wallpaper": { "pauseOnBattery": on } }),
                    cx,
                );
            }),
    )
}

/// The overlay slider shows for an image or a live wallpaper other than the riso print.
fn shows_overlay(source: &Source) -> bool {
    source.kind == "image"
        || (source.kind == "live" && source.module.as_deref() != Some("butler.riso-print"))
}

pub(super) fn conversation(
    ctx: &SectionCtx,
    slice: &Slice,
    words: &Words,
    preview: Option<f64>,
    on_overlay: impl Fn(f64, &mut App) + 'static,
) -> SettingsSection {
    let mut section = SettingsSection::new(
        "conversation",
        SettingsSectionKind::Form,
        words.section_conversation,
    )
    .description(words.conversation_description)
    .child(
        SettingsSwitch::new("show-thinking", words.show_thinking)
            .checked(slice.show_thinking)
            .on_change(toggle(ctx, "show_thinking")),
    );
    // CARVE-OUT(G-wall): the `conversation-background` WallpaperPicker (tiles, image upload,
    // module import, source save); only its overlay slider is kept.
    if let Some(background) = slice.conversation_background.as_ref()
        && shows_overlay(&background.source)
    {
        let value = preview.unwrap_or(background.overlay);
        let label = format!("{} {}%", words.conversation_overlay, value.round());
        let slider = Slider::new("conversation-overlay", value, 0., 95.)
            .step(5.)
            .on_value_change(move |value, _, cx| on_overlay(value, cx));
        let control = Stack::new()
            .gap(Space::Sm)
            .child(Label::new().child(label))
            .child(slider);
        section = section.child(SettingsField::new(words.conversation_background).control(control));
    }
    section
}

pub(super) fn message_box(ctx: &SectionCtx, slice: &Slice, words: &Words) -> SettingsSection {
    let saved = slice.collapse_message_box.unwrap_or(true);
    let fold = toggle_now(ctx, "collapse_message_box");
    let mut section = SettingsSection::new(
        "message-box",
        SettingsSectionKind::Form,
        words.section_message_box,
    )
    .description(words.message_box_description)
    .child(
        SettingsSwitch::new("collapse-message-box", words.collapse_message_box)
            .description(words.collapse_message_box_description)
            .checked(saved)
            .on_change(move |value, window, cx| {
                if value != saved {
                    fold(value, window, cx);
                }
            }),
    );
    if let Some(decoration) = slice.composer_decoration.as_ref() {
        section = decoration_fields(
            section,
            ctx,
            decoration.theme.clone(),
            decoration.character,
            words,
        );
    }
    section
}

/// `ComposerDecorationSettings`: a patch is written only when it changes a value.
fn decoration_fields(
    section: SettingsSection,
    ctx: &SectionCtx,
    theme: String,
    character: bool,
    words: &Words,
) -> SettingsSection {
    let (theme_ctx, current) = (ctx.clone(), theme.clone());
    let control = SegmentedControl::new("composer-decoration", words.composer_decoration, theme)
        .options([
            Choice::new("none", words.none),
            Choice::new("shoreline", words.shoreline),
            Choice::new("cherry", words.cherry),
        ])
        .on_value_change(move |value, _, cx| {
            if value != current {
                nested(
                    &theme_ctx,
                    json!({ "composer_decoration": { "theme": value } }),
                    cx,
                );
            }
        });
    let character_ctx = ctx.clone();
    section
        .child(
            SettingsField::new(words.composer_decoration)
                .description(words.composer_decoration_description)
                .control(control),
        )
        .child(
            SettingsSwitch::new("composer-character", words.composer_character)
                .description(words.composer_character_description)
                .checked(character)
                .on_change(move |value, _, cx| {
                    if value != character {
                        nested(
                            &character_ctx,
                            json!({ "composer_decoration": { "character": value } }),
                            cx,
                        );
                    }
                }),
        )
}

pub(super) fn accessibility(ctx: &SectionCtx, slice: &Slice, words: &Words) -> SettingsSection {
    // CARVE-OUT(reduced-motion): React also reads the OS `prefers-reduced-motion` query
    // (`useSystemReducedMotion`) and locks the switch on with `reduceMotionSystem`; gpui has
    // no such query here, so only the saved value shows.
    SettingsSection::new(
        "accessibility",
        SettingsSectionKind::Form,
        words.section_accessibility,
    )
    .child(
        SettingsSwitch::new("reduce-motion", words.reduce_motion)
            .description(words.reduce_motion_description)
            .checked(slice.reduce_motion)
            .on_change(toggle_now(ctx, "reduce_motion")),
    )
}
