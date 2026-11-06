//! AdaptiveShellSplit (AdaptiveShellSplit.tsx, AdaptiveShellSplitMotion.ts): the conversation
//! frame's split slot, chat | pane, the chat column resizable between 340 and 560px. The pane
//! opens and closes on one motion: it holds its final size and only travels in from the
//! split's end, while the chat card's edge follows it.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, Entity, InteractiveElement as _, IntoElement, KeyDownEvent,
    ParentElement as _, RenderOnce, SharedString, Styled as _, Window, div, px,
};

use super::frame::{
    CHAT_WIDTH_DEFAULT, CHAT_WIDTH_MAX, CHAT_WIDTH_MIN, KEY_STEP, clamp_chat_width,
};
use super::grip::{Drag, HANDLE_WIDTH, HintSide, ResizeHandle};
use super::parts::card_surface;
use crate::tokens::Length;
use crate::ui::blocks::measure;
use crate::ui::blocks::scope::{self, SplitMotion};
use crate::ui::context::Ds;
use crate::ui::strut;

type WidthHandler = Rc<dyn Fn(f32, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct AdaptiveShellSplit {
    id: ElementId,
    chat: Option<AnyElement>,
    pane: Option<AnyElement>,
    pane_open: bool,
    chat_width: f32,
    on_chat_width_change: Option<WidthHandler>,
    resize_label: SharedString,
    resize_hint: Option<SharedString>,
}

impl AdaptiveShellSplit {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            chat: None,
            pane: None,
            pane_open: false,
            chat_width: CHAT_WIDTH_DEFAULT,
            on_chat_width_change: None,
            resize_label: "Resize conversation".into(),
            resize_hint: None,
        }
    }

    /// The conversation column (left): its own `workspace` container.
    pub fn chat(mut self, chat: impl IntoElement) -> Self {
        self.chat = Some(chat.into_any_element());
        self
    }

    /// The pane beside the chat; given while `pane_open` and while it leaves.
    pub fn pane(mut self, pane: impl IntoElement) -> Self {
        self.pane = Some(pane.into_any_element());
        self
    }

    pub fn pane_open(mut self, open: bool) -> Self {
        self.pane_open = open;
        self
    }

    /// The chat column's width in px while the pane is open (340 to 560).
    pub fn chat_width(mut self, width: f32) -> Self {
        self.chat_width = width;
        self
    }

    /// Drag or keyboard resize of the chat column, already clamped. Omit to lock the width.
    pub fn on_chat_width_change(
        mut self,
        handler: impl Fn(f32, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_chat_width_change = Some(Rc::new(handler));
        self
    }

    /// The handle's accessible name and the hint's first line.
    pub fn resize_label(mut self, label: impl Into<SharedString>) -> Self {
        self.resize_label = label.into();
        self
    }

    /// The hint's second line ("Drag to resize"), shown on the chat side.
    pub fn resize_hint(mut self, hint: impl Into<SharedString>) -> Self {
        self.resize_hint = Some(hint.into());
        self
    }
}

/// The key a handle answers to: arrows step, Home and End jump to the ends (Shift triples a step).
fn keyed_width(event: &KeyDownEvent, width: f32) -> Option<f32> {
    let step = if event.keystroke.modifiers.shift {
        KEY_STEP * 3.
    } else {
        KEY_STEP
    };
    match event.keystroke.key.as_str() {
        "left" => Some(width - step),
        "right" => Some(width + step),
        "home" => Some(CHAT_WIDTH_MIN),
        "end" => Some(CHAT_WIDTH_MAX),
        _ => None,
    }
}

impl AdaptiveShellSplit {
    fn handle(&self, window: &mut Window, cx: &mut App, width: f32) -> AnyElement {
        let start: Entity<f32> =
            window.use_keyed_state((self.id.clone(), "start"), cx, |_, _| width);
        let handle = ResizeHandle::new((self.id.clone(), "handle"), HintSide::Start)
            .label(self.resize_label.clone())
            .locked(self.on_chat_width_change.is_none());
        let handle = match &self.resize_hint {
            Some(hint) => handle.hint(hint.clone()),
            None => handle,
        };
        let Some(change) = self.on_chat_width_change.clone() else {
            return handle.into_any_element();
        };
        let keyed = change.clone();
        handle
            .on_drag(move |drag, window, cx| match drag {
                Drag::Begin => start.update(cx, |start, _| *start = width),
                Drag::Move(dx) => {
                    let from = *start.read(cx);
                    change(clamp_chat_width(from + dx), window, cx);
                }
                Drag::End => {}
            })
            .on_key_down(move |event, window, cx| {
                if let Some(next) = keyed_width(event, width) {
                    keyed(clamp_chat_width(next), window, cx);
                    cx.stop_propagation();
                }
            })
            .into_any_element()
    }
}

/// The chat column: in the cards frame a card, as the content card is.
fn chat_column(chat: Option<AnyElement>, ds: &Ds, card: Option<bool>) -> gpui::Div {
    let column = div().relative().flex().flex_col().min_h_0();
    match card {
        Some(transparent) => card_surface(column, ds, transparent),
        None => column.overflow_hidden(),
    }
    .children(chat)
}

/// The divider's grab zone takes no width of its own outside the cards frame: it overlaps the
/// chat and the pane by 4px and 5px; in the cards frame it is the gap between the cards.
fn handle_geometry(cards: bool, ds: &Ds) -> (f32, f32, f32) {
    if cards {
        return (f32::from(ds.len(Length::ShellCardGap)), 0., 0.);
    }
    // DS: AdaptiveShellFrame.module.css:50
    let xs = f32::from(ds.len(Length::SpaceXs));
    (
        HANDLE_WIDTH,
        -xs,
        -(xs + f32::from(ds.len(Length::BorderHairline))),
    )
}

impl RenderOnce for AdaptiveShellSplit {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let vars = scope::vars(cx);
        let motion = vars.and_then(|v| v.split).unwrap_or(SplitMotion {
            progress: f32::from(u8::from(self.pane_open)),
            fade: f32::from(u8::from(self.pane_open)),
            open: self.pane_open,
            chat_width: self.chat_width,
        });
        let width = clamp_chat_width(self.chat_width);
        let present = self.pane_open || motion.progress > 0.001;
        let (measured, recorder) = measure::track((self.id.clone(), "split"), window, cx);
        let ds = Ds::get(cx);
        let cards = vars.is_some_and(|v| v.cards_docked);
        let card = cards.then(|| vars.is_some_and(|v| v.transparent_workspace));
        let chat = self.chat.take();
        let mut split = div()
            .relative()
            .flex()
            .h_full()
            .min_h_0()
            .min_w_0()
            .child(recorder);
        let Some(pane) = self.pane.take().filter(|_| present) else {
            let column = chat_column(chat, ds, card).flex_auto().min_w_0();
            return strut::scope(false, split.child(column));
        };
        // The chat card's edge: from the split's end to its column width, over a negative margin
        // that keeps the flow where it will rest; the pane travels the same distance.
        let split_width = f32::from(measured.width);
        let travel = if split_width > width {
            (1. - motion.progress) * (split_width - width)
        } else {
            0.
        };
        let chat_now = width + travel;
        let reduced = ds.reduced_motion();
        let (handle_width, lead, trail) = handle_geometry(cards, ds);
        split = split
            .child(
                chat_column(chat, ds, card)
                    .debug_selector(move || format!("split-chat-{}", chat_now.round()))
                    .flex_none()
                    .w(px(chat_now))
                    .mr(px(width - chat_now)),
            )
            .child(
                div()
                    .relative()
                    .flex_none()
                    .w(px(handle_width))
                    .ml(px(lead))
                    .mr(px(trail))
                    .debug_selector(|| "split-handle".to_owned())
                    .child(self.handle(window, cx, width)),
            );
        let pane_box = div()
            .relative()
            .flex()
            .flex_col()
            .flex_auto()
            .min_w_0()
            .min_h_0()
            .left(px(if reduced { 0. } else { travel }))
            .opacity(if reduced { motion.fade } else { 1. })
            .child(pane);
        strut::scope(false, split.child(pane_box))
    }
}
