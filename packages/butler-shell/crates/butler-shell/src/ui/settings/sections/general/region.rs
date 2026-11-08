//! `languageRegionSection` and `SettingsSearchableSelect` (the time zone).
use butler_ds::ui::blocks::filtered_select_popover::{
    Filter, FilteredSelectPopover, Group, Item, Width,
};
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::blocks::settings_section::SettingsSection;
use butler_ds::ui::popover::{MenuSize, Popover, PopoverContent};
use butler_ds::ui::select_button::SelectButton;
use butler_ds::ui::tooltip::Align;
use gpui::{App, ElementId, IntoElement as _, ParentElement as _, SharedString, Window, div};
use serde_json::json;

use super::copy::GeneralCopy;
use super::slice::Slice;
use super::{form, options, select};
use crate::ui::settings::{Save, SectionCtx};

/// `timezoneOptions` without `Intl.supportedValuesOf`: React's own fallback list (G-tz).
const FALLBACK: [&str; 6] = [
    "UTC",
    "Asia/Seoul",
    "America/Los_Angeles",
    "America/New_York",
    "Europe/London",
    "Europe/Paris",
];

/// The fallback list, plus the stored zone when it is not in it.
fn zones(current: &str) -> Vec<String> {
    let mut zones: Vec<String> = FALLBACK.iter().map(|zone| (*zone).to_owned()).collect();
    if !current.is_empty() && !zones.iter().any(|zone| zone == current) {
        zones.push(current.to_owned());
    }
    zones
}

pub(super) fn section(
    ctx: &SectionCtx,
    slice: &Slice,
    copy: &'static GeneralCopy,
    window: &mut Window,
    cx: &mut App,
) -> SettingsSection {
    let languages = options(&[("en", copy.languages[0]), ("ko", copy.languages[1])]);
    form("language-region", copy.sections[0])
        .child(
            select(
                ctx,
                "language",
                copy.language,
                &slice.language,
                languages,
                None,
                "language",
            )
            .description(copy.descriptions[0]),
        )
        .child(timezone(ctx, &slice.timezone, copy, window, cx))
}

/// The time zone: a select button over a searchable list.
fn timezone(
    ctx: &SectionCtx,
    current: &str,
    copy: &'static GeneralCopy,
    window: &mut Window,
    cx: &mut App,
) -> SettingsField {
    let popover = Popover::new("timezone", window, cx);
    let search = window.use_keyed_state((ElementId::from("timezone"), "search"), cx, |_, _| {
        SharedString::default()
    });
    let typed = search.read(cx).clone();
    let query = typed.trim().to_lowercase();
    let mut items = Vec::new();
    for zone in zones(current) {
        let label = zone.replace('_', " ");
        let matches = [&label, &zone]
            .iter()
            .any(|text| text.to_lowercase().contains(&query));
        if !matches {
            continue;
        }
        let (ctx, popover, chosen) = (ctx.clone(), popover.clone(), zone.clone());
        items.push(
            Item::new(zone.clone(), SharedString::from(label))
                .selected(zone == current)
                .on_select(move |window, cx| {
                    ctx.save(json!({ "timezone": chosen }), Save::default(), cx);
                    popover.set_open(false, window, cx);
                }),
        );
    }
    let [placeholder, all, empty] = copy.timezone_search;
    let list = FilteredSelectPopover::new("timezone-list", copy.timezone, placeholder, empty)
        .search(typed, move |text, window, cx| {
            search.update(cx, |search, cx| {
                *search = text.to_owned().into();
                cx.notify();
            });
            window.refresh();
        })
        .filters(vec![Filter::new("all", all, |_, _| {})], "all")
        .groups(vec![Group::new("timezones", all, items)])
        .width(Width::Fixed)
        .results_max_rows(6.5);
    let shown = current.replace('_', " ");
    let trigger = popover.trigger(|toggle| {
        SelectButton::new("timezone-trigger")
            .text(shown)
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let content = popover.content(
        PopoverContent::new()
            .align(Align::End)
            .side_offset(6.)
            .menu_size(MenuSize::Fit)
            .child(list),
        window,
        cx,
    );
    SettingsField::new(copy.timezone)
        .description(copy.descriptions[1])
        .setting_id("timezone")
        .control(div().child(trigger).child(content))
}
