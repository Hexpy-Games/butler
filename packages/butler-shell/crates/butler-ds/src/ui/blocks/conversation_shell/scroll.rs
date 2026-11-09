//! ConversationScroll, MessageListSurface and the scroll-to-bottom button (ConversationShell.tsx,
//! ConversationScrollToBottomButton.tsx): the transcript's scroller with its edge fade, the
//! column the message rows flow in, and the chip that jumps back to the newest message.
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement as _,
    RenderOnce, ScrollHandle, SharedString, Styled as _, Window, div, px,
};

use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::blocks::scope;
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::pill_button::{PillButton, Surface};
use crate::ui::scroll::engine::{self, Axis, Config};
use crate::ui::{convert, strut};

/// The scrollbar's lane (`--conversation-scrollbar-offset`).
const SCROLLBAR_OFFSET: f32 = 10.; // DS: ConversationShell.module.css:56
/// The message rows' gap.
const MESSAGE_GAP: f32 = 22.; // DS: ConversationShell.module.css:120
/// The chip's rest height over the composer reserve (desktop, then at 720px and below).
const JUMP_FLOOR: (f32, f32) = (96., 88.); // DS: ConversationShell.module.css:208-251
const JUMP_LIFT: (f32, f32) = (12., 10.); // DS: ConversationShell.module.css:208-251

fn config(id: &ElementId, masked: bool, ds: &Ds) -> Config {
    Config {
        id: (id.clone(), "conversation-scroll").into(),
        axis: Axis::Y,
        size: if masked {
            ds.len(Length::ScrollFadeSize)
        } else {
            px(0.)
        },
        guard: px(0.),
    }
}

/// The transcript scroller's handle, for scrolling to the bottom or tracking a virtual list.
pub fn scroll_handle(id: impl Into<ElementId>, window: &mut Window, cx: &mut App) -> ScrollHandle {
    let id = id.into();
    let config = config(&id, true, Ds::get(cx));
    engine::fade(&config, None, false, window, cx).handle
}

/// Scrolls the transcript to its newest message.
pub fn scroll_to_bottom(handle: &ScrollHandle) {
    handle.scroll_to_bottom();
}

#[derive(IntoElement)]
pub struct ConversationScroll {
    id: ElementId,
    masked: bool,
    scrollable: bool,
    children: Vec<AnyElement>,
}

impl ConversationScroll {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            masked: true,
            scrollable: true,
            children: Vec::new(),
        }
    }

    /// The edge fade (on by default).
    pub fn masked(mut self, masked: bool) -> Self {
        self.masked = masked;
        self
    }

    /// A locked scroller never scrolls: its children lay out in it directly.
    pub fn scrollable(mut self, scrollable: bool) -> Self {
        self.scrollable = scrollable;
        self
    }
}

impl gpui::ParentElement for ConversationScroll {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for ConversationScroll {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let reserve = scope::conversation(cx).map_or(0., |vars| vars.composer_reserve);
        let column = div()
            .flex()
            .flex_col()
            .flex_auto()
            .flex_shrink_0()
            .min_w_0()
            .children(self.children);
        let body = div()
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .pb(px(reserve));
        if !self.scrollable {
            return strut::scope(
                false,
                body.overflow_hidden().child(column).into_any_element(),
            );
        }
        let config = config(&self.id, self.masked, ds);
        let built = engine::scroller(&config, body.child(column), window, cx);
        let thumb = convert::with_alpha(Ds::get(cx).color(Color::LineStrong), 0.7);
        let overlay = crate::ui::scroll::overlay(
            &(self.id.clone(), "conversation-bar").into(),
            &built,
            (Axis::Y, px(SCROLLBAR_OFFSET)),
            thumb,
            window,
            cx,
        );
        strut::scope(
            false,
            div()
                .relative()
                .size_full()
                .min_h_0()
                .child(built.element)
                .child(overlay)
                .into_any_element(),
        )
    }
}

/// How the surface hands its rows to a virtual list.
#[derive(IntoElement)]
pub struct MessageListSurface {
    height: Option<f32>,
    children: Vec<AnyElement>,
}

impl MessageListSurface {
    pub fn new() -> Self {
        Self {
            height: None,
            children: Vec::new(),
        }
    }

    /// A virtualized list: a block of this height whose rows are placed absolutely. The hook for
    /// gpui's `list` and `uniform_list`: pass the list element as the only child.
    pub fn virtualized(mut self, height: f32) -> Self {
        self.height = Some(height);
        self
    }
}

impl Default for MessageListSurface {
    fn default() -> Self {
        Self::new()
    }
}

impl gpui::ParentElement for MessageListSurface {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for MessageListSurface {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let vars = scope::conversation(cx).unwrap_or_default();
        let ds = Ds::get(cx);
        let top = if vars.top_reserve > 0. {
            vars.top_reserve
        } else {
            f32::from(ds.len(Length::TitlebarSafeAreaTop))
        };
        let timing = crate::ui::motion::Timing::token(
            ds,
            crate::tokens::Duration::MotionSlow,
            crate::tokens::Easing::MotionEaseEmphasized,
        );
        let column = div()
            .id((
                vars.motion_id
                    .clone()
                    .unwrap_or_else(|| "conversation".into()),
                "column",
            ))
            .layout_motion(gpui::LayoutMotion {
                duration_ms: if ds.reduced_motion() { 0 } else { timing.ms() },
                easing: timing.easing(),
            })
            .flex()
            .flex_col()
            .flex_none()
            .min_w_0()
            .pt(px(top));
        // Measured: the column's width and its left edge; before that, centred at the gutters' share.
        let column = if vars.column_width > 0. {
            column.w(px(vars.column_width)).ml(px(vars.column_left))
        } else {
            column
                .w(gpui::relative(0.86))
                .max_w(px(super::column::CONTENT_MAX))
                .mx_auto()
        };
        let rows = match self.height {
            Some(height) => column.relative().h(px(height)).children(self.children),
            None => column
                .flex_auto()
                .justify_end()
                .gap(px(MESSAGE_GAP))
                .children(self.children),
        };
        strut::scope(
            false,
            div()
                .flex()
                .flex_col()
                .flex_auto()
                .w_full()
                .min_h_0()
                .child(rows),
        )
    }
}

#[derive(IntoElement)]
pub struct ConversationScrollToBottomButton {
    id: ElementId,
    label: SharedString,
    unread: bool,
    text: Option<SharedString>,
    on_click: Option<crate::ui::blocks::adaptive_shell::parts::Callback>,
}

impl ConversationScrollToBottomButton {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            unread: false,
            text: None,
            on_click: None,
        }
    }

    pub fn unread(mut self, unread: bool) -> Self {
        self.unread = unread;
        self
    }

    pub fn text(mut self, text: impl Into<SharedString>) -> Self {
        self.text = Some(text.into());
        self
    }

    pub fn on_click(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(std::rc::Rc::new(handler));
        self
    }
}

impl RenderOnce for ConversationScrollToBottomButton {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let vars = scope::conversation(cx).unwrap_or_default();
        let narrow = ds.tokens().viewport.0 <= 720.; // DS: ConversationShell.module.css:244
        let (floor, lift) = if narrow {
            (JUMP_FLOOR.1, JUMP_LIFT.1)
        } else {
            (JUMP_FLOOR.0, JUMP_LIFT.0)
        };
        let bottom = floor.max(vars.composer_reserve - lift);
        let side = if narrow {
            f32::from(ds.len(Length::Space6))
        } else {
            32.
        }; // DS: ConversationShell.module.css:204
        let mut pill = PillButton::new(self.id.clone())
            .surface(Surface::Glass)
            .accent(self.unread)
            .icon(icon(Icon::ChevronDown, IconSize::Md, ds));
        if let Some(text) = self.text {
            pill = pill.text(text);
        }
        if let Some(handler) = self.on_click {
            pill = pill.on_click(move |_, window, cx| handler(window, cx));
        }
        // Centred on the column: `right: calc(50% + shift); translateX(50%)`.
        let label = self.label;
        let timing = crate::ui::motion::Timing::token(
            ds,
            crate::tokens::Duration::MotionSlow,
            crate::tokens::Easing::MotionEaseEmphasized,
        );
        div()
            .id((self.id, "column"))
            .layout_motion(gpui::LayoutMotion {
                duration_ms: if ds.reduced_motion() { 0 } else { timing.ms() },
                easing: timing.easing(),
            })
            .debug_selector(move || format!("jump:{label}"))
            .absolute()
            .bottom(px(bottom))
            .left_0()
            .w_full()
            .pl(px(side / 2.))
            .pr(px(side / 2. + 2. * vars.column_shift))
            .flex()
            .justify_center()
            .child(div().min_w_0().child(pill))
    }
}
