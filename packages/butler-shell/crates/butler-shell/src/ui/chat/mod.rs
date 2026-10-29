//! The conversation: a virtualized message list (ConversationShell, MessageRow). It shows what
//! the shell hands it; when the top row comes into view and older messages exist, it asks for
//! them (never the whole chat at once).
mod markdown;
mod markdown_view;
mod message;

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use gpui::{
    AnyElement, Context, EventEmitter, FollowMode, InteractiveElement, IntoElement, ListAlignment,
    ListState, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Window,
    div, list, px,
};

use crate::ui::motion::Hover;
use crate::ui::smooth_scroll::SmoothScroll;
use crate::ui::source::{ChatRef, Message, MessageCursor, MessagePage, SessionId};
use crate::ui::theme::Theme;
use crate::ui::widgets::{HasHover, hover_listener};

/// The chat asks the shell for the window before `cursor`.
pub(crate) struct LoadOlder(pub(crate) ChatRef, pub(crate) MessageCursor);

pub(crate) struct Chat {
    pub(crate) theme: Theme,
    open: Option<ChatRef>,
    pub(crate) messages: Vec<Message>,
    older: Option<MessageCursor>,
    asked_older: bool,
    /// Messages that arrived live, and when (they play the insert motion once).
    born: HashMap<SharedString, Instant>,
    open_activity: HashSet<SharedString>,
    list: ListState,
    /// Wheel notches glide (smooth_scroll.rs).
    smooth: SmoothScroll,
    /// Width of the chat card, set by the shell every frame.
    card_w: f32,
    /// Room under the last message for the floating composer.
    reserve: f32,
    hover: Hover,
}

impl EventEmitter<LoadOlder> for Chat {}

impl HasHover for Chat {
    fn hover_state(&mut self) -> &mut Hover {
        &mut self.hover
    }
}

/// The column width for a card width (MessageRow's max width).
pub(crate) fn column(card_w: f32) -> f32 {
    if card_w <= 560. {
        card_w - 24.
    } else {
        (card_w * 0.86).min(760.)
    }
}

impl Chat {
    pub(crate) fn new(theme: Theme) -> Self {
        let list = ListState::new(2, ListAlignment::Bottom, px(600.));
        list.set_follow_mode(FollowMode::Tail);
        Self {
            theme,
            open: None,
            messages: Vec::new(),
            older: None,
            asked_older: false,
            born: HashMap::new(),
            open_activity: HashSet::new(),
            smooth: SmoothScroll::list(list.clone()),
            list,
            card_w: 640.,
            reserve: 120.,
            hover: Hover::default(),
        }
    }

    /// Shows `chat` from its latest window (`None`: a new chat, or nothing open).
    pub(crate) fn show(&mut self, chat: Option<ChatRef>, page: Option<MessagePage>) {
        self.open = chat;
        let (messages, older) = page.map_or((Vec::new(), None), |p| (p.messages, p.older));
        // The last turn's activity starts open, as in the product.
        self.open_activity.clear();
        if let Some(last) = messages.iter().rev().find(|m| !m.activity.is_empty()) {
            self.open_activity.insert(last.id.clone());
        }
        self.messages = messages;
        self.older = older;
        self.asked_older = false;
        self.born.clear();
        self.smooth.cancel();
        self.list.reset(self.messages.len() + 2);
    }

    /// Prepends the window before the current first message.
    pub(crate) fn prepend(&mut self, chat: &ChatRef, page: MessagePage) {
        if self.open.as_ref() != Some(chat) {
            return;
        }
        let n = page.messages.len();
        self.messages.splice(0..0, page.messages);
        self.older = page.older;
        self.asked_older = false;
        self.list.splice(1..1, n);
    }

    /// A message added or grown by the running turn.
    pub(crate) fn upsert(&mut self, session: &SessionId, message: Message) {
        if self.open.as_ref().map(|c| &c.session) != Some(session) {
            return;
        }
        if let Some(ix) = self.messages.iter().position(|m| m.id == message.id) {
            self.messages[ix] = message;
            self.list.splice(ix + 1..ix + 2, 1);
            return;
        }
        let at = self.messages.len();
        self.born.insert(message.id.clone(), Instant::now());
        self.messages.push(message);
        self.list.splice(at + 1..at + 1, 1);
        self.smooth.cancel();
        self.list.scroll_to_reveal_item(at + 2);
    }

    /// Scrolls the conversation for a wheel event caught over a dialog (same smooth scroll).
    pub(crate) fn wheel_from_overlay(
        &mut self,
        e: &gpui::ScrollWheelEvent,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        if self.smooth.wheel(e, window) {
            cx.notify();
        }
    }

    /// Called by the shell each frame with the card width and the composer's reserve.
    pub(crate) fn set_layout(&mut self, card_w: f32, reserve: f32) {
        self.card_w = card_w;
        if (reserve - self.reserve).abs() > 0.5 {
            self.reserve = reserve;
            let n = self.messages.len();
            self.list.splice(n + 1..n + 2, 1);
        }
    }

    fn top_row(&mut self, cx: &mut Context<Self>) -> AnyElement {
        if let (Some(chat), Some(cursor), false) = (&self.open, &self.older, self.asked_older) {
            self.asked_older = true;
            cx.emit(LoadOlder(chat.clone(), cursor.clone()));
        }
        div().h(px(16.)).into_any_element()
    }

    fn render_item(&mut self, ix: usize, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if ix == 0 {
            return self.top_row(cx);
        }
        let Some(msg) = self.messages.get(ix - 1).cloned() else {
            return div().h(px(self.reserve)).into_any_element();
        };
        let open = self.open_activity.contains(&msg.id);
        let toggle_id = SharedString::from(format!("act-{}", msg.id));
        let hovered = self.hover.is(&toggle_id);
        let toggle = (!msg.activity.is_empty()).then(|| {
            let id = msg.id.clone();
            div()
                .id(toggle_id.clone())
                .on_hover(hover_listener(&toggle_id, cx))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if !this.open_activity.remove(&id) {
                        this.open_activity.insert(id.clone());
                    }
                    this.list.splice(ix..ix + 1, 1);
                    cx.notify();
                }))
                .child(message::activity_header(&msg, open, hovered, &self.theme))
                .into_any_element()
        });
        let ctx = message::RowCtx {
            theme: &self.theme,
            column: column(self.card_w),
            activity_open: open,
            born: self.born.get(&msg.id).copied(),
        };
        div()
            .w_full()
            .flex()
            .justify_center()
            .child(message::row(ix, &msg, &ctx, toggle))
            .into_any_element()
    }
}

impl Render for Chat {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("chat-list")
            .relative()
            .size_full()
            .child(self.smooth.layer())
            .child(list(self.list.clone(), cx.processor(Self::render_item)).size_full())
    }
}
