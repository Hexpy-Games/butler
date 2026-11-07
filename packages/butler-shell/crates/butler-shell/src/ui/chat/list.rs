//! `Conversation`, `MessageList`, `TranscriptRows` and the scroll/virtualizer hooks
//! (`useMessageList`, `useMessageListLayout`, `useLiveMessageId`, `useConversationAutoScroll`).
//! The rows are gpui `list` items laid in the ConversationShell column; the list follows the
//! newest message until the reader scrolls away, and a jump button brings it back.
mod turn;

use std::collections::HashMap;
use std::rc::Rc;

use butler_ds::tokens::Length;
use butler_ds::ui::blocks::conversation_shell::ConversationScrollToBottomButton;
use butler_ds::ui::blocks::message_row::{MessageRow, Role};
use butler_ds::ui::blocks::scope;
use butler_ds::ui::context::{Ds, Lang};
use gpui::{
    AnyElement, App, Entity, FollowMode, Global, InteractiveElement as _, IntoElement as _,
    ListAlignment, ListState, ParentElement as _, SharedString, Styled as _, WeakEntity, Window,
    div, list, px, relative,
};

use super::TranscriptCtx;
use super::activity::status::current_turn_status;
use super::intro::chats_intro;
use super::queue::queued_rows;
use super::row::message_row;
use crate::ui::smooth_scroll::SmoothScroll;
use crate::ui::source::wire::{
    MessageRecord, QueuedMessageRecordState, SessionQueueView, SessionView, SessionViewTurn,
};
use turn::{Live, collapse_assistant_attempts, reuse, turn_info};

/// `MESSAGE_LIST_TOP_PADDING` (conversationUtils.tsx).
const TOP_PADDING: f32 = 32.;
/// `DEFAULT_COMPOSER_RESERVE` (conversationUtils.tsx).
const DEFAULT_RESERVE: f32 = 170.;
/// `CONTENT_MAX` of the DS message column, for a column the shell has not measured yet.
const COLUMN_MAX: f32 = 760.;
/// `COLUMN_SHARE` of the same column.
const COLUMN_SHARE: f32 = 0.86;

/// The window before the one shown: the shell fetches it and merges it into the view.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(crate) struct OlderRequest {
    pub(crate) session_id: String,
    pub(crate) before_cursor: i64,
    pub(crate) before_cursor_token: Option<String>,
}

type OlderHandler = Rc<dyn Fn(OlderRequest, &mut App)>;

#[derive(Default)]
struct OlderHandlers(Option<OlderHandler>);

impl Global for OlderHandlers {}

/// Registers what runs when the top row comes into view and older messages exist.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(crate) fn on_load_older(cx: &mut App, handler: impl Fn(OlderRequest, &mut App) + 'static) {
    cx.default_global::<OlderHandlers>().0 = Some(Rc::new(handler));
}

/// One list item.
#[derive(Clone)]
enum Row {
    /// The room above the first message; reaching it asks for older messages.
    Top,
    /// A message; the live one also carries the running turn it shows.
    Message(Rc<MessageRecord>, Option<Rc<SessionViewTurn>>),
    /// The running turn's own row, when no message carries its activity.
    Activity(Rc<SessionViewTurn>),
    Queued(Rc<SessionQueueView>),
    Intro,
    /// The room under the last row for the floating composer.
    Reserve,
}

fn same_turn(a: Option<&Rc<SessionViewTurn>>, b: Option<&Rc<SessionViewTurn>>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => Rc::ptr_eq(a, b),
        _ => false,
    }
}

fn same(a: &Row, b: &Row) -> bool {
    match (a, b) {
        (Row::Top, Row::Top) | (Row::Intro, Row::Intro) | (Row::Reserve, Row::Reserve) => true,
        (Row::Message(a, x), Row::Message(b, y)) => {
            Rc::ptr_eq(a, b) && same_turn(x.as_ref(), y.as_ref())
        }
        (Row::Activity(a), Row::Activity(b)) => Rc::ptr_eq(a, b),
        (Row::Queued(a), Row::Queued(b)) => Rc::ptr_eq(a, b),
        _ => false,
    }
}

/// Tells the list which rows changed: the rows between the common head and tail.
fn splice_changes(list: &ListState, old: &[Row], new: &[Row]) {
    let head = old.iter().zip(new).take_while(|(a, b)| same(a, b)).count();
    let tail = old[head..]
        .iter()
        .rev()
        .zip(new[head..].iter().rev())
        .take_while(|(a, b)| same(a, b))
        .count();
    let (removed, added) = (old.len() - head - tail, new.len() - head - tail);
    if removed > 0 || added > 0 {
        list.splice(head..head + removed, added);
    }
}

/// `queuedConversationItems`: whether a queued follow-up still waits or failed, and is not yet
/// a message of the transcript.
fn has_visible_queue(
    queue: &SessionQueueView,
    messages: &[Rc<MessageRecord>],
    session: &str,
) -> bool {
    let shown = |id: &str| messages.iter().any(|message| message.id == id);
    queue.queued_messages.iter().any(|record| {
        let key = record.client_message_id.as_deref().unwrap_or(&record.id);
        record.chat_id == session
            && matches!(
                record.state,
                QueuedMessageRecordState::Queued | QueuedMessageRecordState::Failed
            )
            && !shown(key)
            && !record.dispatched_message_id.as_deref().is_some_and(shown)
    })
}

/// What one open session's transcript keeps between frames.
struct State {
    session: String,
    list: ListState,
    smooth: SmoothScroll,
    view: Option<Rc<SessionView>>,
    client: Option<butler_shell_client::ShellClient>,
    queue: Option<Rc<SessionQueueView>>,
    messages: Vec<Rc<MessageRecord>>,
    turn: Option<Rc<SessionViewTurn>>,
    live: Live,
    rows: Vec<Row>,
    /// The cursor (and its token) of the window before the first message, when one exists.
    older: Option<(i64, Option<String>)>,
    asked: Option<i64>,
    reserve: f32,
    /// The reader scrolled away from the newest message.
    away: bool,
    unread: bool,
    seen: Option<String>,
    version: String,
}

impl State {
    fn new(session: String, weak: WeakEntity<Self>) -> Self {
        let list = ListState::new(0, ListAlignment::Bottom, px(600.));
        list.set_follow_mode(FollowMode::Tail);
        list.set_scroll_handler(move |event, window, cx| {
            let away = !event.is_following_tail;
            let _ = weak.update(cx, |state, _| {
                if state.away != away {
                    state.away = away;
                    window.refresh();
                }
            });
        });
        Self {
            session,
            smooth: SmoothScroll::list(list.clone()),
            list,
            view: None,
            client: None,
            queue: None,
            messages: Vec::new(),
            turn: None,
            live: Live::default(),
            rows: Vec::new(),
            older: None,
            asked: None,
            reserve: DEFAULT_RESERVE,
            away: false,
            unread: false,
            seen: None,
            version: String::new(),
        }
    }

    /// Takes in this frame's view, queue and composer reserve; tells the list what changed.
    fn sync(&mut self, t: &TranscriptCtx, queue: Option<&SessionQueueView>, reserve: Option<f32>) {
        self.client = t.client.clone();
        let view_changed = self.view.as_deref() != Some(t.view);
        let queue_changed = self.queue.as_deref() != queue;
        if view_changed {
            self.view = Some(Rc::new(t.view.clone()));
        }
        if queue_changed {
            self.queue = queue.map(|queue| reuse(self.queue.as_ref(), queue.clone()));
        }
        if view_changed || queue_changed || self.rows.is_empty() {
            self.rebuild();
        }
        let reserve = reserve.unwrap_or(self.reserve);
        if (reserve - self.reserve).abs() > 0.5 {
            self.reserve = reserve;
            let last = self.rows.len().saturating_sub(1);
            self.list.splice(last..last + 1, 1);
        }
        if self.seen.is_none() || !self.away {
            self.seen = Some(self.version.clone());
            self.unread = false;
        } else if self.seen.as_deref() != Some(self.version.as_str()) {
            self.unread = true;
        }
    }

    fn rebuild(&mut self) {
        let Some(view) = self.view.clone() else {
            return;
        };
        let previous: HashMap<String, Rc<MessageRecord>> = self
            .messages
            .iter()
            .map(|message| (message.id.clone(), message.clone()))
            .collect();
        self.messages = collapse_assistant_attempts(&view.messages)
            .into_iter()
            .map(|message| reuse(previous.get(&message.id), message))
            .collect();
        let turn = view
            .active_turn
            .clone()
            .map(|turn| reuse(self.turn.as_ref(), turn));
        self.turn = turn;
        let info = turn_info(&view);
        let live = self.live.message(&self.messages, info.as_ref());
        let mut rows = vec![Row::Top];
        for (ix, message) in self.messages.iter().enumerate() {
            let carried = if live == Some(ix) {
                self.turn.clone()
            } else {
                None
            };
            rows.push(Row::Message(message.clone(), carried));
        }
        if let (true, Some(turn)) = (
            info.is_some_and(|info| info.show) && live.is_none(),
            &self.turn,
        ) {
            rows.push(Row::Activity(turn.clone()));
        }
        if let Some(queue) = self
            .queue
            .as_ref()
            .filter(|queue| has_visible_queue(queue, &self.messages, &view.session_id))
        {
            rows.push(Row::Queued(queue.clone()));
        }
        if view.session_id == "general" {
            rows.push(Row::Intro);
        }
        rows.push(Row::Reserve);
        splice_changes(&self.list, &self.rows, &rows);
        self.rows = rows;
        let window = &view.message_window;
        self.older = window
            .previous_cursor
            .filter(|_| window.has_more.unwrap_or(!window.complete))
            .map(|cursor| (cursor, window.previous_cursor_token.clone()));
        self.version = self.messages.last().map_or_else(
            || "empty".to_owned(),
            |last| {
                format!(
                    "{}:{}:{}:{}",
                    last.id,
                    last.cursor
                        .map_or_else(String::new, |cursor| cursor.to_string()),
                    last.status.as_deref().unwrap_or(""),
                    last.text.len()
                )
            },
        );
    }

    /// `scrollToBottom`: follow the newest message again.
    fn to_bottom(&mut self) {
        self.smooth.cancel();
        self.list.set_follow_mode(FollowMode::Tail);
        self.away = false;
        self.unread = false;
        self.seen = Some(self.version.clone());
    }
}

/// The transcript: rows in the ConversationShell list surface, auto-scroll and follow-latest.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(crate) fn transcript(
    t: &TranscriptCtx,
    queue: Option<&SessionQueueView>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let key = (
        gpui::ElementId::from(SharedString::from(t.view.session_id.clone())),
        "transcript",
    );
    let session = t.view.session_id.clone();
    let state = window.use_keyed_state(key, cx, |_, cx| State::new(session, cx.weak_entity()));
    let reserve = scope::conversation(cx).map(|vars| vars.composer_reserve);
    state.update(cx, |state, _| state.sync(t, queue, reserve));
    let (list_state, smooth, away, unread) = {
        let s = state.read(cx);
        (s.list.clone(), s.smooth.clone(), s.away, s.unread)
    };
    let rows_state = state.clone();
    let rows = list(list_state, move |ix, window, cx| {
        render_row(&rows_state, ix, window, cx)
    })
    .size_full();
    let jump = away.then(|| jump_button(&state, unread, cx));
    div()
        .id("transcript")
        .relative()
        .size_full()
        .child(smooth.layer())
        .child(rows)
        .children(jump)
        .into_any_element()
}

/// `ScrollToBottomButton.ts`.
fn jump_button(state: &Entity<State>, unread: bool, cx: &App) -> AnyElement {
    let (aria, latest, fresh) = match Ds::get(cx).lang() {
        Lang::En => (
            "Scroll to the latest message and composer",
            "Latest",
            "New messages",
        ),
        Lang::Ko => (
            "최신 메시지와 입력창으로 이동",
            "최신으로 이동",
            "새 메시지",
        ),
    };
    let state = state.clone();
    ConversationScrollToBottomButton::new("transcript-jump", aria)
        .unread(unread)
        .text(if unread { fresh } else { latest })
        .on_click(move |window, cx| {
            state.update(cx, |state, _| state.to_bottom());
            window.refresh();
        })
        .into_any_element()
}

/// The message column a row flows in: the measured column, or its share before that.
fn in_column(row: AnyElement, cx: &App) -> AnyElement {
    let vars = scope::conversation(cx).unwrap_or_default();
    let column = div().flex().flex_col().flex_none().min_w_0();
    let column = if vars.column_width > 0. {
        column.w(px(vars.column_width)).ml(px(vars.column_left))
    } else {
        column
            .w(relative(COLUMN_SHARE))
            .max_w(px(COLUMN_MAX))
            .mx_auto()
    };
    div().w_full().child(column.child(row)).into_any_element()
}

/// The room above the first message; asks once per window for the older messages.
fn top_row(state: &Entity<State>, cx: &mut App) -> AnyElement {
    let request = state.update(cx, |state, _| {
        let (cursor, token) = state.older.clone()?;
        if state.asked == Some(cursor) {
            return None;
        }
        state.asked = Some(cursor);
        Some(OlderRequest {
            session_id: state.session.clone(),
            before_cursor: cursor,
            before_cursor_token: token,
        })
    });
    let handler = cx.default_global::<OlderHandlers>().0.clone();
    if let (Some(request), Some(handler)) = (request, handler) {
        handler(request, cx);
    }
    let vars = scope::conversation(cx).unwrap_or_default();
    let top = if vars.top_reserve > 0. {
        vars.top_reserve
    } else {
        f32::from(Ds::get(cx).len(Length::TitlebarSafeAreaTop))
    };
    div().h(px(top + TOP_PADDING)).into_any_element()
}

/// `TranscriptRows`: one list item.
fn render_row(state: &Entity<State>, ix: usize, window: &mut Window, cx: &mut App) -> AnyElement {
    let (row, view, client) = {
        let s = state.read(cx);
        (s.rows.get(ix).cloned(), s.view.clone(), s.client.clone())
    };
    let (Some(row), Some(view)) = (row, view) else {
        return div().into_any_element();
    };
    let t = TranscriptCtx {
        view: &view,
        client,
    };
    let element = match row {
        Row::Top => return top_row(state, cx),
        Row::Reserve => {
            let reserve =
                scope::conversation(cx).map_or(DEFAULT_RESERVE, |vars| vars.composer_reserve);
            return div().h(px(reserve)).into_any_element();
        }
        Row::Message(message, _) => message_row(&message, &t, window, cx),
        Row::Activity(_) => match current_turn_status(&t, window, cx) {
            Some(status) => MessageRow::new("active-turn-activity", Role::Assistant)
                .activity()
                .child(status)
                .into_any_element(),
            None => div().into_any_element(),
        },
        Row::Queued(queue) => queued_rows(&queue, &t, window, cx),
        Row::Intro => MessageRow::new("chats-intro", Role::Assistant)
            .bubble()
            .child(chats_intro(&t, window, cx))
            .into_any_element(),
    };
    in_column(element, cx)
}
