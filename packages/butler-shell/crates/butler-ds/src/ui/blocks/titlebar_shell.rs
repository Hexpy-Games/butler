//! DS TitlebarShell (TitlebarShell.tsx / TitlebarShell.module.css): the 48px title row. The
//! title with its subtitle and actions, controls at the end, the split variant whose chat group
//! ends where the chat card does, the inset beside a collapsed sidebar, and the slot for
//! window controls the app draws itself.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, SharedString, Styled as _, Window, WindowControlArea, div, px,
    relative,
};

use super::scope::{self, ActionScale, ShellVars, Spec};
use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::blocks::adaptive_shell::frame::clamp_chat_width;
use crate::ui::context::Ds;
use crate::ui::icon_button::IconButton;
use crate::ui::typo::{Role, Typo};

type BackHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// `leadingVisibility`: `narrow` shows the control only at compact widths.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LeadingVisibility {
    #[default]
    Always,
    Narrow,
}

/// `leadingSize`: `glyph` is a square the size of the title line, `auto` keeps the control's size.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LeadingSize {
    #[default]
    Glyph,
    Auto,
}

/// `--titlebar-start-padding` / `--titlebar-end-padding` of a bar not in a narrow window.
const INLINE_PADDING: f32 = 18.; // DS: TitlebarShell.module.css:5
/// The window controls sit 10px from the end edge and the row leaves their width less 20px.
const CONTROLS_INSET: f32 = 10.; // DS: TitlebarShell.module.css:91
/// Fallback of `--titlebar-action-size` (a phone raises it).
const ACTION_SIZE: f32 = 30.; // DS: TitlebarShell.module.css:80

#[derive(IntoElement)]
pub struct TitlebarShell {
    id: ElementId,
    title: SharedString,
    back: Option<(SharedString, BackHandler)>,
    subtitle: Option<AnyElement>,
    title_actions: Option<AnyElement>,
    leading: Option<AnyElement>,
    leading_visibility: LeadingVisibility,
    leading_size: LeadingSize,
    chat_trailing: Option<AnyElement>,
    split_chat_width: Option<f32>,
    trailing: Option<AnyElement>,
    window_controls: Option<AnyElement>,
    collapsed: bool,
    drag_region: bool,
    start_padding: Option<f32>,
}

impl TitlebarShell {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            back: None,
            subtitle: None,
            title_actions: None,
            leading: None,
            leading_visibility: LeadingVisibility::Always,
            leading_size: LeadingSize::Glyph,
            chat_trailing: None,
            split_chat_width: None,
            trailing: None,
            window_controls: None,
            collapsed: false,
            drag_region: false,
            start_padding: None,
        }
    }

    /// Up one level from a nested screen: a back button at the title's start.
    pub fn back(
        mut self,
        label: impl Into<SharedString>,
        on_back: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.back = Some((label.into(), Rc::new(on_back)));
        self
    }

    pub fn subtitle(mut self, subtitle: impl IntoElement) -> Self {
        self.subtitle = Some(subtitle.into_any_element());
        self
    }

    /// Controls after the whole title line (the conversation's menu).
    pub fn title_actions(mut self, actions: impl IntoElement) -> Self {
        self.title_actions = Some(actions.into_any_element());
        self
    }

    pub fn leading(mut self, leading: impl IntoElement) -> Self {
        self.leading = Some(leading.into_any_element());
        self
    }

    pub fn leading_visibility(mut self, visibility: LeadingVisibility) -> Self {
        self.leading_visibility = visibility;
        self
    }

    pub fn leading_size(mut self, size: LeadingSize) -> Self {
        self.leading_size = size;
        self
    }

    /// Controls at the chat card's trailing edge.
    pub fn chat_trailing(mut self, trailing: impl IntoElement) -> Self {
        self.chat_trailing = Some(trailing.into_any_element());
        self
    }

    /// The chat column's width while the browser pane is open: the same width the split gets.
    pub fn split_chat_width(mut self, width: Option<f32>) -> Self {
        self.split_chat_width = width;
        self
    }

    pub fn trailing(mut self, trailing: impl IntoElement) -> Self {
        self.trailing = Some(trailing.into_any_element());
        self
    }

    /// Window controls the app draws itself (Windows and Linux).
    pub fn window_controls(mut self, controls: impl IntoElement) -> Self {
        self.window_controls = Some(controls.into_any_element());
        self
    }

    pub fn collapsed(mut self, collapsed: bool) -> Self {
        self.collapsed = collapsed;
        self
    }

    /// Makes the bar a window drag region.
    pub fn drag_region(mut self) -> Self {
        self.drag_region = true;
        self
    }

    /// `--titlebar-start-padding` set by the host (a viewer fixture), not by the bar's state.
    pub fn start_padding(mut self, padding: f32) -> Self {
        self.start_padding = Some(padding);
        self
    }
}

/// The geometry the bar takes from tokens and the enclosing shell.
struct Metrics {
    start: f32,
    end: f32,
    gap: f32,
    controls: f32,
    action: ActionScale,
    compact: bool,
}

impl Metrics {
    fn of(bar: &TitlebarShell, grouped: bool, ds: &Ds, vars: Option<ShellVars>) -> Self {
        let compact = ds.compact();
        let len = |token| f32::from(ds.len(token));
        let chrome_left = vars.map_or_else(
            || len(Length::ChromeFloatingToggleLeft),
            |v| v.chrome_toggle_left,
        );
        let (start, end, gap) = if compact {
            // DS: TitlebarShell.module.css:175-181
            let gutter = len(Length::SpaceMd);
            let toggle = len(Length::ChromeFloatingToggleSize);
            (
                gutter + chrome_left + toggle,
                gutter,
                if grouped {
                    len(Length::SpaceSm)
                } else {
                    len(Length::SpaceXs)
                },
            )
        } else {
            let collapsed = vars.map_or_else(
                || len(Length::TitlebarCollapsedLeftPadding),
                |v| v.collapsed_left_padding,
            );
            let start = bar.start_padding.unwrap_or(if bar.collapsed {
                collapsed
            } else {
                INLINE_PADDING
            });
            (
                start,
                INLINE_PADDING,
                if grouped {
                    len(Length::SpaceSm)
                } else {
                    len(Length::SpaceMd)
                },
            )
        };
        let tokens = ds.tokens();
        Self {
            start,
            end,
            gap,
            controls: vars.map_or(0., |v| v.window_controls_width),
            action: ActionScale {
                side: tokens
                    .try_len(Length::TitlebarActionSize)
                    .unwrap_or(ACTION_SIZE),
                icon: tokens
                    .try_len(Length::TitlebarActionIconSize)
                    .unwrap_or_else(|| len(Length::IconSizeMd)),
            },
            compact,
        }
    }
}

/// An end control group: it never shrinks and its buttons take the title row's action size.
fn actions(content: AnyElement, scale: ActionScale) -> AnyElement {
    scope::scoped(
        Spec {
            action: Some(scale),
            ..Spec::default()
        },
        div().flex_none().flex().items_center().child(content),
    )
    .into_any_element()
}

fn copy(bar: &mut TitlebarShell, m: &Metrics, ds: &Ds) -> Div {
    let line = ds.len(Length::TypoAppTitleLineHeight);
    let title = div()
        .flex_shrink(1.)
        .min_w_0()
        .overflow_hidden()
        .child(Typo::new(Role::AppTitle, bar.title.clone()).truncate());
    let subtitle = bar.subtitle.take().filter(|_| !m.compact).map(|subtitle| {
        div()
            .flex_shrink(999.)
            .min_w_0()
            .overflow_hidden()
            .text_color(ds.color(Color::TextTertiary))
            .text_size(ds.len(Length::TypoCaptionSize))
            .line_height(ds.len(Length::TypoCaptionLineHeight))
            .child(subtitle)
    });
    let has_actions = bar.title_actions.is_some();
    let title_actions = bar.title_actions.take().map(|content| {
        // Centred on the title line and no taller than it: margin-block of half the difference.
        let margin = (f32::from(line) - m.action.side) / 2.;
        div()
            .flex_none()
            .my(px(margin))
            .child(actions(content, m.action))
    });
    let copy = div()
        .flex()
        .items_baseline()
        .gap(ds.len(Length::SpaceSm))
        .min_w_0()
        .child(title)
        .children(subtitle)
        .children(title_actions);
    // The actions may reach past the line, so the bar then does not clip them.
    if has_actions {
        copy
    } else {
        copy.overflow_hidden()
    }
}

/// The leading control: a glyph-sized square, or the control at its own size pulled back by its
/// inner inset so its label lines up where the title would start.
fn leading(bar: &mut TitlebarShell, m: &Metrics, ds: &Ds) -> Option<AnyElement> {
    let content = bar.leading.take()?;
    if bar.leading_visibility == LeadingVisibility::Narrow && !m.compact {
        return None;
    }
    let slot = div().flex().flex_none().items_center().justify_center();
    Some(
        match (bar.leading_size, bar.leading_visibility, m.compact) {
            (LeadingSize::Auto, _, _) => slot
                .ml(-ds.len(Length::SpaceXs))
                .text_color(ds.color(Color::TextPrimary))
                .child(content)
                .into_any_element(),
            (_, LeadingVisibility::Narrow, _) => slot
                .text_color(ds.color(Color::TextTertiary))
                .child(content)
                .into_any_element(),
            _ => {
                let side = ds.len(Length::TypoAppTitleLineHeight);
                slot.size(side)
                    .text_color(ds.color(Color::TextTertiary))
                    .child(content)
                    .into_any_element()
            }
        },
    )
}

/// Back, leading, then the title line: one row.
fn identity(bar: &mut TitlebarShell, m: &Metrics, ds: &Ds) -> Div {
    let back = bar.back.take().map(|(label, on_back)| {
        let button = IconButton::new((bar.id.clone(), "back"), label)
            .glyph(Icon::ArrowLeft)
            .on_click(move |event, window, cx| on_back(event, window, cx));
        div()
            .flex()
            .flex_none()
            .ml(-ds.len(Length::SpaceXs))
            .child(button)
    });
    div()
        .flex()
        .flex_auto()
        .items_center()
        .min_w_0()
        .gap(ds.len(Length::SpaceSm))
        .children(back)
        .children(leading(bar, m, ds))
        .child(copy(bar, m, ds))
}

fn background(ds: &Ds, vars: Option<ShellVars>) -> gpui::Hsla {
    if vars.is_some_and(|v| v.cards_docked || v.transparent_workspace) {
        gpui::transparent_black()
    } else {
        ds.color(Color::TitlebarBg)
    }
}

impl RenderOnce for TitlebarShell {
    fn render(mut self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let vars = scope::vars(cx);
        let split = self.split_chat_width;
        let grouped = self.chat_trailing.is_some() || split.is_some();
        let m = Metrics::of(&self, grouped, ds, vars);
        let identity = identity(&mut self, &m, ds);
        let chat_trailing = self.chat_trailing.take().map(|c| actions(c, m.action));
        let trailing = self.trailing.take().map(|t| actions(t, m.action));
        let identity_group: AnyElement = if grouped {
            let mut group = div()
                .flex()
                .items_center()
                .min_w_0()
                .gap(ds.len(if m.compact {
                    Length::SpaceXs
                } else {
                    Length::SpaceMd
                }))
                .child(identity)
                .children(chat_trailing);
            group = match split {
                Some(width) => {
                    // The chat group ends where the chat card does (TitlebarShell.module.css:117).
                    let card = vars.map_or((0., 0.), |v| (v.card_start, v.card_end));
                    let basis = clamp_chat_width(width) + card.0 - m.start - m.end + card.1;
                    group.flex_grow(0.).flex_shrink(1.).flex_basis(px(basis))
                }
                None => group.flex_auto(),
            };
            group.into_any_element()
        } else {
            identity.into_any_element()
        };
        let controls = self.window_controls.take().filter(|_| !m.compact).map(|c| {
            let room = (m.controls - 2. * CONTROLS_INSET).max(0.);
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .right(px(CONTROLS_INSET))
                .min_w(px(room))
                .flex()
                .items_center()
                .justify_end()
                .child(actions(c, m.action))
        });
        let end = if m.compact { m.end } else { m.end + m.controls };
        let mut bar = div()
            .relative()
            .flex()
            .items_center()
            .justify_between()
            .w(relative(1.))
            .min_h(ds.len(Length::TitlebarSafeAreaTop))
            .gap(px(m.gap))
            .pl(px(m.start))
            .pr(px(end))
            .pt(if m.compact {
                ds.len(Length::SafeAreaTop)
            } else {
                px(0.)
            })
            .text_color(ds.color(Color::TextPrimary))
            .bg(background(ds, vars))
            .child(identity_group)
            .children(trailing)
            .children(controls);
        if self.drag_region {
            bar = bar.window_control_area(WindowControlArea::Drag);
        }
        bar
    }
}
