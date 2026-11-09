//! DS NavRow (NavRow.tsx / NavRowContent.tsx / NavRow.module.css): a navigation row with an
//! icon column, a label that ellipsises, an optional badge and actions, and a full-width meta
//! line. It sizes itself by the sidebar density, draws the surface's row fills, and, when it
//! has an `onClick`, is a stretched Clickable. [`NavRowSwap`] is a trailing slot that swaps its
//! rest content for row actions on hover; [`NavRowChildren`] nests rows under a guide line.
mod children;
mod controls;
pub(crate) mod metrics;
mod swap;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, Entity, FocusHandle, FontWeight, IntoElement,
    ParentElement as _, RenderOnce, SharedString, Styled as _, Window, div, px, svg,
};

pub use children::NavRowChildren;
pub use swap::NavRowSwap;

use self::controls::Controls;
use self::metrics::{Metrics, density_of, fills, metrics};
use super::scope::{self, Spec};
use crate::tokens::{Color, Density, Duration as DsDuration, Easing, Length, Number};
use crate::ui::Icon;
use crate::ui::clickable::Clickable;
use crate::ui::context::Ds;
use crate::ui::control::State;
use crate::ui::motion::{Timing, Transition, transition};

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// When a row's actions show (`actionsVisibility`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ActionsVisibility {
    #[default]
    Visible,
    /// Only while the row is hovered or holds focus.
    Hover,
    /// As `Hover`, and not at all in a compact window.
    HoverCompactHidden,
}

enum Label {
    Text(SharedString),
    Element(AnyElement),
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent props, as the React NavRow API"
)]
#[derive(IntoElement)]
pub struct NavRow {
    id: ElementId,
    label: Label,
    icon: Option<AnyElement>,
    glyph: Option<Icon>,
    reserve_icon: bool,
    multiline: bool,
    meta: Option<AnyElement>,
    badge: Option<SharedString>,
    active: bool,
    disabled: bool,
    actions: Option<AnyElement>,
    visibility: ActionsVisibility,
    density: Option<Density>,
    gap: Option<f32>,
    on_click: Option<Handler>,
}

impl NavRow {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: Label::Text(label.into()),
            icon: None,
            glyph: None,
            reserve_icon: false,
            multiline: false,
            meta: None,
            badge: None,
            active: false,
            disabled: false,
            actions: None,
            visibility: ActionsVisibility::Visible,
            density: None,
            gap: None,
            on_click: None,
        }
    }

    /// A label that is an element (a title with an avatar after it, a muted text).
    pub fn label_element(mut self, label: impl IntoElement) -> Self {
        self.label = Label::Element(label.into_any_element());
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// A DS glyph drawn at the density's icon size (`.icon svg` takes `--sidebar-icon-size`).
    pub fn glyph(mut self, glyph: Icon) -> Self {
        self.glyph = Some(glyph);
        self
    }

    /// Keeps an empty icon column so the label aligns with iconned rows.
    pub fn reserve_icon(mut self) -> Self {
        self.reserve_icon = true;
        self
    }

    /// Vertical breathing room and first-line icon alignment for a wrapping label.
    pub fn multiline(mut self) -> Self {
        self.multiline = true;
        self
    }

    /// A full-width second line, independent of the first-line action track.
    pub fn meta(mut self, meta: impl IntoElement) -> Self {
        self.meta = Some(meta.into_any_element());
        self
    }

    pub fn badge(mut self, badge: impl Into<SharedString>) -> Self {
        self.badge = Some(badge.into());
        self
    }

    /// The current row: the selected fill, a medium-weight label and a full-opacity icon.
    pub fn active(mut self) -> Self {
        self.active = true;
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }

    pub fn actions_visibility(mut self, visibility: ActionsVisibility) -> Self {
        self.visibility = visibility;
        self
    }

    /// A standalone row's density; inside a SidebarShell rows follow the shell's.
    pub fn density(mut self, density: Density) -> Self {
        self.density = Some(density);
        self
    }

    /// `--sidebar-row-gap` for this row (a group header sets `--space-2`).
    pub fn row_gap(mut self, gap: f32) -> Self {
        self.gap = Some(gap);
        self
    }

    /// Makes the row a stretched Clickable.
    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

/// What the row reads from the tokens and scope, once, before it builds.
struct Look {
    m: Metrics,
    compact: bool,
    sidebar: bool,
    fg: gpui::Hsla,
    hover_fill: gpui::Hsla,
    selected_fill: gpui::Hsla,
    /// The transition and target for the row's swapped-in actions.
    reveal: Transition,
    target: bool,
    /// `1lh` of the row, and `--icon-size-md`.
    line: f32,
    icon_md: f32,
}

fn look(row: &NavRow, reveal: Transition, target: bool, cx: &App) -> Look {
    let ds = Ds::get(cx);
    let mut m = metrics(ds, density_of(ds, row.density, cx));
    if let Some(gap) = row.gap {
        m.gap = gap;
    }
    let (hover_fill, selected_fill) = fills(ds, cx);
    let fg = if row.disabled {
        ds.color(Color::InteractiveDisabledFg)
    } else {
        ds.color(Color::TextPrimary)
    };
    Look {
        m,
        compact: ds.compact(),
        sidebar: scope::in_density(cx),
        fg,
        hover_fill,
        selected_fill,
        reveal,
        target,
        line: f32::from(ds.len(Length::TypoBodyLineHeight)),
        icon_md: f32::from(ds.len(Length::IconSizeMd)),
    }
}

impl NavRow {
    /// The icon column (`.icon`): a glyph or an element centred in a square, dimmed unless
    /// the row is active; an empty reserved column when only `reserve_icon` is set.
    fn icon_cell(&mut self, look: &Look, ds: &Ds) -> Option<Div> {
        let glyph = self.glyph.take().map(|glyph| {
            svg()
                .path(glyph.path())
                .size(px(look.m.icon))
                .text_color(look.fg)
                .into_any_element()
        });
        let content = glyph.or_else(|| self.icon.take());
        if content.is_none() && !self.reserve_icon {
            return None;
        }
        let mut cell = div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .w(px(look.m.icon))
            .opacity(if self.active { 1. } else { 0.82 }); // DS: NavRow.module.css:164,93
        if self.multiline {
            // `.multiline .icon`: one label line tall.
            let line = if look.compact {
                Length::TypoAppTitleLineHeight
            } else {
                Length::TypoLabelLineHeight
            };
            cell = cell.min_h(ds.len(line));
        } else {
            cell = cell.h(px(look.m.icon));
        }
        Some(cell.children(content))
    }

    fn label_cell(&mut self, look: &Look, ds: &Ds) -> Div {
        let (size, line) = if look.compact {
            (Length::FontSize4, Length::TypoAppTitleLineHeight)
        } else {
            (Length::FontSize2, Length::TypoLabelLineHeight)
        };
        let weight = if self.active {
            Number::FontWeightMedium
        } else {
            Number::FontWeightRegular
        };
        let label = div()
            .flex_1()
            .min_w_0()
            .font_family(ds.body_font().clone())
            .font_weight(FontWeight(ds.number(weight)))
            .text_size(ds.len(size))
            .line_height(ds.len(line));
        let label = if self.multiline {
            label.overflow_wrap(gpui::OverflowWrap::Anywhere)
        } else {
            label.overflow_hidden().whitespace_nowrap().text_ellipsis()
        };
        match std::mem::replace(&mut self.label, Label::Text(SharedString::default())) {
            Label::Text(text) => label.child(text),
            Label::Element(element) => label.child(element),
        }
    }

    /// The row's content: the label region and control region on the first line, the meta
    /// under them, spanning the width.
    fn body(&mut self, look: &Look, ds: &Ds) -> Div {
        let m = look.m;
        let multiline = self.multiline;
        let aligned = move |row: Div| {
            if multiline {
                row.items_start()
            } else {
                row.items_center()
            }
        };
        let icon = self.icon_cell(look, ds);
        let has_icon = icon.is_some();
        let labels = aligned(div().flex().flex_1().min_w_0().gap(px(m.gap)))
            .children(icon)
            .child(self.label_cell(look, ds));
        let controls = Controls {
            badge: self.badge.take(),
            actions: self.actions.take(),
            visibility: self.visibility,
            fixed_height: (self.multiline && self.meta.is_some()).then(|| {
                ds.len(if look.compact {
                    Length::TypoAppTitleLineHeight
                } else {
                    Length::TypoLabelLineHeight
                })
            }),
        }
        .build(look, ds);
        let first = aligned(div().flex().w_full().min_w_0().gap(px(m.gap)))
            .child(labels)
            .children(controls);
        let meta = self.meta.take().map(|meta| {
            let inset = if has_icon { m.icon + m.gap } else { 0. };
            div().w_full().min_w_0().pl(px(inset)).child(meta)
        });
        let row_gap = if self.multiline {
            ds.len(Length::SpaceXs)
        } else {
            px(m.gap)
        };
        let mut body = div()
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .gap(row_gap)
            .child(first)
            .children(meta);
        if self.multiline {
            body = body.py(ds.len(Length::SpaceSm));
        }
        body
    }
}

impl RenderOnce for NavRow {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let interactive = self.on_click.is_some() && !self.disabled;
        let state = window.use_keyed_state((self.id.clone(), "state"), cx, |_, _| State::default());
        let focus = window
            .use_keyed_state((self.id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        let target = interactive && row_reveal(&state, &focus, window, cx);
        let timing = Timing::token(
            Ds::get(cx),
            DsDuration::MotionFast,
            Easing::MotionEaseStandard,
        );
        let reveal = transition(
            (self.id.clone(), "reveal-actions"),
            (f32::from(target), false),
            &timing,
            window,
            cx,
        );
        let look = look(&self, reveal, target, cx);
        let ds = Ds::get(cx);
        let body = self.body(&look, ds);
        let radius = ds.len(Length::RadiusControl);
        let spec = Spec {
            row_reveal: Some(target),
            ..Spec::default()
        };
        let (padding, height) = (px(look.m.padding), px(look.m.height));
        let body = scope::scoped(spec, body);
        if !interactive {
            let row = div()
                .flex()
                .w_full()
                .min_h(height)
                .px(padding)
                .items_center()
                .rounded(radius)
                .text_color(look.fg)
                .font_family(ds.body_font().clone());
            let row = if self.disabled {
                row.cursor_not_allowed()
            } else {
                row
            };
            return row.child(body).into_any_element();
        }
        let row = Clickable::new(self.id)
            .state(state)
            .focus(focus)
            .stretch()
            .fills(look.hover_fill, look.selected_fill)
            .metrics(padding, height);
        let row = if self.active { row.selected(true) } else { row };
        let row = match self.on_click.take() {
            Some(handler) => row.on_click(move |event, window, cx| handler(event, window, cx)),
            None => row,
        };
        row.child(body).into_any_element()
    }
}

/// Whether the row shows its actions on hover or while it holds keyboard focus.
fn row_reveal(state: &Entity<State>, focus: &FocusHandle, window: &Window, cx: &App) -> bool {
    state.read(cx).hovered
        || (focus.contains_focused(window, cx) && Ds::get(cx).modality().focus_visible())
}
