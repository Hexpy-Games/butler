//! FilteredSelectSearch.tsx, FilteredSelectItemButton.tsx and FilteredSelectFooter.tsx: the search
//! field with its clear button, a result row (with its reveal-on-hover actions) and the chip rows.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

use super::{Filter, Item};
use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::button::{Button, Shape, Size, Variant};
use crate::ui::context::Ds;
use crate::ui::control::{Blend, Control};
use crate::ui::icon::{IconSize, icon};
use crate::ui::text::Input;
use crate::ui::tooltip::Tooltip;

pub(super) type Change = Rc<dyn Fn(&str, &mut Window, &mut App)>;

/// A chip: its label, whether it is the chosen one, and what choosing it does.
pub(super) type Chip = (SharedString, bool, Rc<dyn Fn(&mut Window, &mut App)>);

/// The search field; a clear button shows while it holds text.
pub(super) fn search(
    id: &ElementId,
    placeholder: &SharedString,
    value: &SharedString,
    on_change: &Change,
    ds: &Ds,
) -> AnyElement {
    let change = on_change.clone();
    let input = Input::new((id.clone(), "search"))
        .placeholder(placeholder.clone())
        .value(value.clone())
        .on_change(move |text, window, cx| change(text, window, cx));
    let clear = (!value.is_empty()).then(|| {
        let change = on_change.clone();
        let mut control = Control::new((id.clone(), "clear"), ds);
        let size = px(22.); // DS: FilteredSelectPopover.module.css:78
        control.width = crate::ui::control::Width::Fixed(22.);
        control.height = Some(size);
        control.radius = ds.len(Length::RadiusPill);
        control.scale = false;
        control.fill = Blend::hover(gpui::transparent_black(), ds.color(Color::Selection));
        control.fg = Blend::hover(ds.color(Color::TextSecondary), ds.color(Color::TextPrimary));
        control.on_click(Some(Rc::new(move |_, window, cx| change("", window, cx))));
        control.children = vec![icon(Icon::X, IconSize::Sm, ds).into_any_element()];
        control.outer = Some(Box::new(|el| el.absolute().top(px(5.)).right(px(6.))));
        control
    });
    div()
        .relative()
        .min_w_0()
        .child(input)
        .children(clear)
        .into_any_element()
}

/// A row of pill chips (the filters, the footer options): the chosen one is flat selection.
pub(super) fn chips(id: &ElementId, chips: Vec<Chip>, ds: &Ds) -> AnyElement {
    let room = ds.len(Length::FocusRingRoom);
    let selection = ds.color(Color::Selection);
    let row = chips
        .into_iter()
        .enumerate()
        .map(|(index, (label, selected, on_select))| {
            let button = Button::new((id.clone(), SharedString::from(format!("chip-{index}"))))
                .size(Size::Xs)
                .shape(Shape::Pill)
                .variant(if selected {
                    Variant::Secondary
                } else {
                    Variant::Borderless
                })
                .text(label);
            let mut control = button.control(ds);
            control.fill = if selected {
                Blend::flat(selection)
            } else {
                Blend::hover(gpui::transparent_black(), selection)
            };
            control.fg = Blend::hover(
                if selected {
                    ds.color(Color::TextPrimary)
                } else {
                    ds.color(Color::TextSecondary)
                },
                ds.color(Color::TextPrimary),
            );
            if ds.compact() {
                let side = ds.len(Length::SpaceMd);
                control.padding = [side, control.padding[1], side, control.padding[3]];
            }
            control.on_click(Some(Rc::new(move |_, window, cx| on_select(window, cx))));
            control.into_any_element()
        });
    div()
        .flex()
        .min_w_0()
        .gap(ds.len(Length::SpaceXs))
        .m(-room)
        .p(room)
        .children(row)
        .into_any_element()
}

pub(super) fn filters(id: &ElementId, filters: Vec<Filter>, active: &str, ds: &Ds) -> AnyElement {
    let list = filters
        .into_iter()
        .map(|filter| (filter.label, filter.id == active, filter.on_select))
        .collect();
    chips(id, list, ds)
}

/// The row's text: the label with its muted description beside it.
fn copy(label: AnyElement, description: Option<SharedString>, ds: &Ds) -> gpui::Div {
    let line = ds.len(Length::MenuItemLineHeight);
    div()
        .flex()
        .items_baseline()
        .min_w_0()
        .gap(ds.len(Length::Space1))
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_size(ds.len(Length::FontSize3))
                .line_height(line)
                .child(label),
        )
        .children(description.map(|text| {
            div()
                .flex_none()
                .text_color(ds.color(Color::TextSecondary))
                .text_size(ds.len(Length::FontSize2))
                .line_height(line)
                .child(text)
        }))
}

/// The leading glyph slot of a row.
fn icon_slot(glyph: AnyElement, ds: &Ds) -> gpui::Div {
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(ds.len(Length::MenuItemLineHeight))
        .child(glyph)
}

/// The check mark of the chosen row.
fn check(ds: &Ds) -> gpui::Div {
    div()
        .flex()
        .items_center()
        .justify_center()
        .h(ds.len(Length::MenuItemLineHeight))
        .text_color(ds.color(Color::TextPrimary))
        .child(icon(Icon::CheckIcon, IconSize::Sm, ds))
}

/// One result row: the select button, and beside it the actions that show on hover.
pub(super) fn row(id: &ElementId, item: Item, ds: &Ds) -> AnyElement {
    let selection = ds.color(Color::Selection);
    let line = ds.len(Length::MenuItemLineHeight);
    let tooltip = item.tooltip.clone();
    let selected = item.selected;
    let on_select = item.on_select.clone();
    let icon_slot = item.icon.map(|glyph| icon_slot(glyph, ds));
    let copy = copy(item.label, item.description, ds);
    let check = selected.then(|| check(ds));
    let has_actions = item.actions.is_some();
    let inner = div()
        .id((id.clone(), "select"))
        .flex()
        .items_start()
        .flex_1()
        .min_w_0()
        .min_h(ds.menu_item_height())
        .gap(ds.len(Length::Space1))
        .px(ds.len(Length::Space2))
        .py(ds.len(Length::MenuItemPaddingBlock))
        .rounded(ds.len(Length::RadiusControl))
        .text_color(ds.color(Color::TextPrimary))
        .line_height(line)
        .cursor_pointer()
        .children(icon_slot)
        .child(copy)
        .child(div().flex_1())
        .children(check)
        .on_click(move |_, window, cx| {
            if let Some(on_select) = &on_select {
                on_select(window, cx);
            }
        });
    let inner = if has_actions {
        inner
    } else {
        inner.hover_style(move |style| style.bg(selection))
    };
    let inner = if selected && !has_actions {
        inner.bg(selection)
    } else {
        inner
    };
    let control: AnyElement = match tooltip {
        Some(label) => Tooltip::new((id.clone(), "tip"))
            .label(label)
            .child(inner)
            .into_any_element(),
        None => inner.into_any_element(),
    };
    match item.actions {
        Some(actions) => with_actions(id, control, actions, selected, ds),
        None => control,
    }
}

/// The row owns the fill; the actions keep their column and show on hover.
fn with_actions(
    id: &ElementId,
    control: AnyElement,
    actions: AnyElement,
    selected: bool,
    ds: &Ds,
) -> AnyElement {
    let selection = ds.color(Color::Selection);
    let group: SharedString = format!("{id:?}-row").into();
    let mut row = div()
        .id((id.clone(), "row"))
        .group(group.clone())
        .flex()
        .items_center()
        .min_w_0()
        .rounded(ds.len(Length::RadiusControl))
        .hover_style(move |style| style.bg(selection))
        .child(control)
        .child(
            div()
                .flex()
                .items_center()
                .pr(ds.len(Length::Space1))
                .opacity(0.)
                .group_hover_style(group, |style| style.opacity(1.))
                .child(actions),
        );
    if selected {
        row = row.bg(selection);
    }
    row.into_any_element()
}
