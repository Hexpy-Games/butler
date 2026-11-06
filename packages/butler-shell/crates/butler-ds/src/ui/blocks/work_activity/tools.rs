//! The toolchain of a work activity (WorkActivityToolGroup.tsx, WorkActivityToolRow.tsx): one
//! tool is an outline row that opens its details; several are one capped outline control with a
//! count per kind, opening ordered text-style rows; an `after` footer stays under the control.
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

use super::Look;
use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::collapsible::Collapsible;
use crate::ui::context::Ds;
use crate::ui::control::{Blend, Control, Ring, Width};
use crate::ui::convert;
use crate::ui::icon::icon_px;
use crate::ui::strut;
use crate::ui::typo::{Tone, Typo, Weight};

/// The widest a tool control gets. // DS: WorkActivityBlock.module.css:206
const MAX_WIDTH: f32 = 760.;

/// One tool call of a work activity.
pub struct ToolItem {
    pub id: SharedString,
    pub icon: Option<Icon>,
    pub title: SharedString,
    pub details: Option<SharedString>,
    /// The group noun counted in the collapsed summary ("2 Search"), supplied by the caller.
    pub summary_label: SharedString,
    /// An always-visible footer below the control and its expanded list.
    pub after: Option<AnyElement>,
}

impl ToolItem {
    pub fn new(
        id: impl Into<SharedString>,
        title: impl Into<SharedString>,
        summary_label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            icon: None,
            title: title.into(),
            details: None,
            summary_label: summary_label.into(),
            after: None,
        }
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn details(mut self, details: impl Into<SharedString>) -> Self {
        self.details = Some(details.into());
        self
    }

    pub fn after(mut self, after: impl gpui::IntoElement) -> Self {
        self.after = Some(after.into_any_element());
        self
    }
}

fn open_state(id: &SharedString, window: &mut Window, cx: &mut App) -> gpui::Entity<bool> {
    window.use_keyed_state(format!("{id}-open"), cx, |_, _| false)
}

fn toggle(state: gpui::Entity<bool>) -> impl Fn(&gpui::ClickEvent, &mut Window, &mut App) {
    move |_, _, cx| {
        state.update(cx, |open, cx| {
            *open = !*open;
            cx.notify();
        });
    }
}

/// The outline of a tool control: hairline border, control radius, a faint surface; hover, focus
/// and the open state take the selection fill and the strong line.
fn outline(id: String, open: bool, look: Look, ds: &Ds) -> Control {
    let mut control = Control::new(id, ds);
    let selection = ds.color(Color::Selection);
    let rest = convert::with_alpha(ds.color(Color::Surface), 0.74);
    control.scale = false;
    control.radius = ds.len(Length::RadiusControl);
    control.fill = if open {
        Blend::flat(selection)
    } else {
        Blend::hover(rest, selection)
    };
    let (line, strong) = (ds.color(Color::Line), ds.color(Color::LineStrong));
    control.border = Some((
        ds.len(Length::BorderHairline),
        if open {
            Blend::flat(strong)
        } else {
            Blend::hover(line, strong)
        },
    ));
    control.fg = Blend::flat(Look::muted(ds));
    // The padding includes the border.
    let edge = ds.len(Length::BorderHairline);
    control.padding = [
        ds.len(Length::Space2) + edge,
        px(look.tool_pad_y) + edge,
        ds.len(Length::Space2) + edge,
        px(look.tool_pad_y) + edge,
    ];
    control.gap = ds.len(Length::Space2);
    control.justify_center = false;
    control.ring = Ring::Spread;
    control.width = Width::Auto;
    // `display: grid; width: fit-content`: block-level, not an inline box on a text line.
    control.inline = false;
    control
}

/// The text of a tool title: body, or caption when compact, in the muted tone.
fn title(text: SharedString, look: Look) -> Typo {
    let typo = if look.compact {
        Typo::caption(text)
    } else {
        Typo::body(text)
    };
    typo.truncate().weight(Weight::Regular).tone(Tone::Inherit)
}

fn details_text(text: SharedString, look: Look, ds: &Ds) -> AnyElement {
    let typo = Typo::caption(text);
    div()
        .w_full()
        .pl(look.line() + ds.len(Length::Space2))
        .text_color(Look::muted(ds))
        .child(strut::flex_scope(false, typo.tone(Tone::Inherit)))
        .into_any_element()
}

/// A `1lh` square slot for a tool's icon or chevron.
fn slot(look: Look, child: impl gpui::IntoElement) -> gpui::Div {
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(look.line())
        .child(child)
}

/// A tool as an outline row (`nested` false) or as a text-style row inside a group.
fn tool_row(
    tool: &ToolItem,
    nested: bool,
    look: Look,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let state = open_state(&tool.id, window, cx);
    let open = *state.read(cx);
    let ds = Ds::get(cx);
    let glyph = tool
        .icon
        .map(|icon| slot(look, icon_px(icon, ds.len(Length::IconSizeMd))).into_any_element());
    // A non-nested row always reserves the icon slot; a nested one only draws a given icon.
    let lead =
        glyph.or_else(|| (!nested).then(|| div().flex_none().size(look.line()).into_any_element()));
    let chevron = (nested && tool.details.is_some()).then(|| {
        let icon = if open {
            Icon::ChevronDown
        } else {
            Icon::ChevronRight
        };
        slot(look, icon_px(icon, ds.len(Length::IconSizeSm)))
            .text_color(ds.color(Color::TextTertiary))
            .into_any_element()
    });
    let name = title(tool.title.clone(), look);
    let head = if nested {
        let row = div()
            .flex()
            .items_center()
            .w_full()
            .min_w_0()
            .gap(ds.len(Length::Space2))
            .text_color(Look::muted(ds))
            .children(lead)
            .child(div().min_w_0().child(name))
            .children(chevron);
        match tool.details {
            Some(_) => row
                .hover_style(|s| s.text_color(ds.color(Color::TextSecondary)))
                .id(SharedString::from(format!("{}-row", tool.id)))
                .cursor_pointer()
                .on_click(toggle(state.clone()))
                .into_any_element(),
            None => row.into_any_element(),
        }
    } else {
        let mut control = outline(format!("{}-tool", tool.id), open, look, ds);
        control.children = lead.into_iter().chain([name.into_any_element()]).collect();
        if tool.details.is_some() {
            control.on_click(Some(std::rc::Rc::new(toggle(state.clone()))));
        }
        div()
            .flex()
            .max_w(px(MAX_WIDTH))
            .child(control)
            .into_any_element()
    };
    let detail = tool.details.clone().map(|text| {
        // The closed collapsible is gone, and with it the row gap above it: the gap is its padding.
        let ds = Ds::get(cx);
        Collapsible::new(format!("{}-details", tool.id), open).child(
            div()
                .pt(ds.len(Length::SpaceXs))
                .child(details_text(text, look, ds)),
        )
    });
    div()
        .flex()
        .flex_col()
        .child(head)
        .children(detail)
        .into_any_element()
}

/// `2 Search, 1 Bash`: the count of each summary label, in first-seen order.
fn summary(tools: &[ToolItem]) -> String {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for tool in tools {
        let label = tool.summary_label.trim().to_owned();
        match counts.iter_mut().find(|(known, _)| *known == label) {
            Some((_, count)) => *count += 1,
            None => counts.push((label, 1)),
        }
    }
    counts
        .into_iter()
        .map(|(label, count)| format!("{count} {label}").trim().to_owned())
        .collect::<Vec<_>>()
        .join(", ")
}

/// The toolchain: a single tool row, or the capped group control.
pub(super) fn group(
    id: &SharedString,
    mut tools: Vec<ToolItem>,
    look: Look,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    if tools.len() == 1 && tools[0].after.is_none() {
        return tool_row(&tools[0], false, look, window, cx);
    }
    let key = SharedString::from(format!("{id}-group"));
    let state = open_state(&key, window, cx);
    let open = *state.read(cx);
    let text = summary(&tools);
    let ds = Ds::get(cx);
    let mut control = outline(format!("{key}-button"), open, look, ds);
    let chevron = icon_px(
        if open {
            Icon::ChevronDown
        } else {
            Icon::ChevronRight
        },
        ds.len(Length::IconSizeSm),
    );
    control.children = vec![
        div()
            .min_w_0()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_ellipsis()
            .child(text)
            .into_any_element(),
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(look.line())
            .text_color(ds.color(Color::TextTertiary))
            .child(chevron)
            .into_any_element(),
    ];
    control.on_click(Some(std::rc::Rc::new(toggle(state.clone()))));
    let rows: Vec<AnyElement> = tools
        .iter()
        .map(|tool| tool_row(tool, true, look, window, cx))
        .collect();
    let ds = Ds::get(cx);
    let list = div()
        .flex()
        .flex_col()
        .gap(ds.len(Length::Space2))
        .mt(ds.len(Length::Space2) + ds.len(Length::SpaceXs))
        .text_color(Look::muted(ds))
        .children(rows);
    let attachments: Vec<AnyElement> = tools
        .iter_mut()
        .filter_map(|tool| tool.after.take())
        .map(|after| {
            div()
                .flex()
                .mt(ds.len(Length::SpaceXs))
                .text_color(Look::muted(ds))
                .child(after)
                .into_any_element()
        })
        .collect();
    div()
        .flex()
        .flex_col()
        .child(div().flex().max_w(px(MAX_WIDTH)).child(control))
        .child(Collapsible::new(format!("{key}-list"), open).child(list))
        .children(attachments)
        .into_any_element()
}
