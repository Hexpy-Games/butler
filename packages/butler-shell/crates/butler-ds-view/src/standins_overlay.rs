//! Stand-ins for the blocks the Popover showcase fills its surfaces with (ComposerControl,
//! FilteredSelectPopover, SuggestionList). They follow the React CSS they replace, draw from
//! tokens and go away when the blocks land. They are not part of `butler-ds`; the search box of
//! the filtered select is display only (a text field has no change callback yet).
use std::rc::Rc;

use butler_ds::tokens::{Color, Length, Number};
use butler_ds::ui::Icon;
use butler_ds::ui::button::{Button, Shape, Size as ButtonSize, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::pill_button::PillButton;
use butler_ds::ui::scroll::ScrollArea;
use butler_ds::ui::text::Input;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, ClickEvent, FontWeight, InteractiveElement as _, IntoElement as _,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    px,
};

/// ComposerControl (ComposerControl.tsx): a PillButton with an icon and a caption label.
pub(crate) fn composer_control(
    id: &'static str,
    glyph: Icon,
    label: &'static str,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    PillButton::new(id)
        .icon(icon(glyph, IconSize::Sm, Ds::get(cx)))
        .child(Typo::caption(label).tone(Tone::Primary))
        .on_click(on_click)
        .into_any_element()
}

/// One row of the filtered list.
type OnSelect = Rc<dyn Fn(&mut Window, &mut App)>;

pub(crate) struct Row {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    pub(crate) selected: bool,
    pub(crate) on_select: OnSelect,
}

/// FilteredSelectPopover with `width="fixed"` (FilteredSelectPopover.module.css): title, search,
/// the filter chips, the results (a fixed-height scroller of titled groups) and no footer.
pub(crate) fn filtered_select(
    title: &'static str,
    search: &'static str,
    filter: &'static str,
    group: &'static str,
    rows: &[Row],
    window: &Window,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let viewport = window.viewport_size();
    let width = 320_f32.min(f32::from(viewport.width) - 32.); // DS: FilteredSelectPopover.module.css:11
    let space1 = ds.len(Length::SpaceXs);
    let heading = div()
        .px(ds.len(Length::SpaceSm))
        .pt(px(3.)) // DS: FilteredSelectPopover.module.css:21
        .pb(space1)
        .text_size(ds.len(Length::FontSize2))
        .line_height(ds.len(Length::TypoLabelLineHeight))
        .font_weight(FontWeight(ds.number(Number::FontWeightSemibold)))
        .child(title);
    let search = div()
        .px(space1)
        .child(Input::new("popover-filtered-search").placeholder(search));
    let room = ds.len(Length::FocusRingRoom);
    let chips = div()
        .flex()
        .gap(space1)
        .mt(space1 - room)
        .pt(room)
        .px(space1)
        .pb(space1)
        .child(
            Button::new("popover-filtered-chip")
                .size(ButtonSize::Xs)
                .shape(Shape::Pill)
                .variant(Variant::Secondary)
                .text(filter),
        );
    // `height: min(6.5 rows * 30px, 42vh)` (DS: FilteredSelectPopover.module.css:196).
    let results_height = (6.5_f32 * 30.).min(f32::from(viewport.height) * 0.42);
    let results = div()
        .flex()
        .flex_col()
        .h(px(results_height))
        .border_t(ds.len(Length::BorderHairline))
        .border_b(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .child(
            ScrollArea::new("popover-filtered-results")
                .fill()
                .child(group_of(group, rows, ds)),
        );
    div()
        .flex()
        .flex_col()
        .gap(space1)
        .w(px(width))
        .child(heading)
        .child(search)
        .child(chips)
        .child(results)
        .into_any_element()
}

fn group_of(title: &'static str, rows: &[Row], ds: &Ds) -> AnyElement {
    let label = div()
        .pt(ds.len(Length::SpaceSm))
        .px(ds.len(Length::SpaceSm))
        .pb(ds.len(Length::SpaceXs))
        .text_color(ds.color(Color::MenuGroupLabelColor))
        .text_size(ds.len(Length::MenuGroupLabelSize))
        .line_height(ds.len(Length::MenuGroupLabelLineHeight))
        .font_weight(FontWeight(ds.number(Number::FontWeightMedium)))
        .child(title);
    let items = rows.iter().map(|row| {
        let on_select = row.on_select.clone();
        let mut item = div()
            .id(row.id)
            .cursor_pointer()
            .on_click(move |_, window, cx| on_select(window, cx))
            .flex()
            .items_start()
            .justify_between()
            .gap(ds.len(Length::SpaceXs))
            .min_h(ds.len(Length::MenuItemHeight))
            .px(ds.len(Length::SpaceSm))
            .py(ds.len(Length::MenuItemPaddingBlock))
            .rounded(ds.len(Length::RadiusControl))
            .text_size(ds.len(Length::FontSize3))
            .line_height(ds.len(Length::MenuItemLineHeight))
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .child(row.label),
            );
        if row.selected {
            item =
                item.bg(ds.color(Color::Selection))
                    .child(icon(Icon::CheckIcon, IconSize::Sm, ds));
        }
        item.into_any_element()
    });
    div()
        .flex()
        .flex_col()
        .gap(px(2.)) // DS: FilteredSelectPopover.module.css:176
        .child(label)
        .child(div().flex().flex_col().gap(px(2.)).children(items))
        .into_any_element()
}

/// SuggestionRow (SuggestionList.module.css): a favicon glyph, the host and path of the address.
pub(crate) fn suggestion_row(address: &'static str, active: bool, ds: &Ds) -> AnyElement {
    let mut row = div()
        .flex()
        .items_center()
        .gap(ds.len(Length::SpaceSm))
        .min_h(ds.len(Length::ControlHeightLg))
        .px(ds.len(Length::SpaceSm))
        .rounded(ds.len(Length::RadiusControl))
        .text_size(ds.len(Length::FontSize2))
        .line_height(ds.len(Length::TypoLabelLineHeightTight))
        .child(
            div()
                .flex_none()
                .text_color(ds.color(Color::TextTertiary))
                .child(icon(Icon::Globe2, IconSize::Md, ds)),
        )
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(SharedString::from(address)),
        );
    if active {
        row = row.bg(ds.color(Color::SelectionStrong));
    }
    row.into_any_element()
}

/// MessageRow with `role="system"` and `compactionEvent` (MessageRow.module.css `.row`,
/// `.compactionEvent`, `.body`): the summary line of compacted turns.
pub(crate) fn message_row_system(text: &'static str, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    div()
        .pt(ds.len(Length::SpaceXl))
        .pb(px(28.)) // DS: MessageRow.module.css:32
        .child(
            div()
                .min_w_0()
                .pt(px(2.)) // DS: MessageRow.module.css:44
                .text_size(ds.len(Length::FontSize3))
                .line_height(ds.len(Length::TypoBodyLineHeightDocument))
                .child(text),
        )
        .into_any_element()
}

/// ProviderLogo (ProviderLogo.module.css): the service logo, a 16px box. The vendored SVGs are
/// not ported, so this draws a neutral mark in the same box.
pub(crate) fn provider_logo(_name: &'static str) -> AnyElement {
    let side = px(16.); // DS: ProviderLogo.module.css:4 (`--icon-size-md`)
    div().size(side).flex_none().into_any_element()
}
