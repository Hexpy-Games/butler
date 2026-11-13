//! `Conversation`, `MessageList`, `TranscriptRows` and the scroll/virtualizer hooks
//! (`useMessageList`, `useMessageListLayout`, `useLiveMessageId`, `useConversationAutoScroll`).
//! The rows are gpui `list` items laid in the ConversationShell column; the list follows the
//! newest message until the reader scrolls away, and a jump button brings it back.
mod answers;
mod request;
mod turn;

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use butler_ds::tokens::Length;
use butler_ds::ui::blocks::conversation_shell::ConversationScrollToBottomButton;
use butler_ds::ui::blocks::message_row::{Entering, MessageRow, Role};
use butler_ds::ui::blocks::scope;
use butler_ds::ui::context::Ds;
use gpui::{
    AnyElement, App, Entity, FollowMode, Global, InteractiveElement as _, IntoElement as _,
    ListAlignment, ListState, ParentElement as _, SharedString, Styled as _, WeakEntity, Window,
    div, list, px, relative,
};

use super::TranscriptCtx;
use super::activity::status::StatusLineView;
use super::activity::timeline::turn_activity_panel;
use super::assistant::{FooterMeta, session_branch_seed};
use super::intro::{self, chats_intro};
use super::queue::queued_rows;
use super::row::message_row;
use crate::ui::i18n::transcript as strings;
use crate::ui::inspector::sections::asks::{pending_asks, request_source_message};
use crate::ui::source::wire::{
    MessageRecord, MessageRecordRole, ProgressRow, SessionQueueView, SessionView, SessionViewTurn,
};
use turn::{Live, collapse_assistant_attempts, has_visible_queue, reuse, turn_info, version};

/// `MESSAGE_LIST_TOP_PADDING` (conversationUtils.tsx).
const TOP_PADDING: f32 = 32.;
/// `DEFAULT_COMPOSER_RESERVE` (conversationUtils.tsx).
const DEFAULT_RESERVE: f32 = 170.;
/// `CONTENT_MAX` of the DS message column, for a column the shell has not measured yet.
const COLUMN_MAX: f32 = 760.;
/// `COLUMN_SHARE` of the same column.
const COLUMN_SHARE: f32 = 0.86;

/// The window before the one shown: the shell fetches it and merges it into the view.
pub(crate) struct OlderRequest {
    pub(crate) session_id: String,
    pub(crate) before_cursor_token: Option<String>,
}

type OlderHandler = Rc<dyn Fn(OlderRequest, &mut App)>;

#[derive(Default)]
struct OlderHandlers(Option<OlderHandler>);

impl Global for OlderHandlers {}

/// Registers what runs when the top row comes into view and older messages exist.
pub(crate) fn on_load_older(cx: &mut App, handler: impl Fn(OlderRequest, &mut App) + 'static) {
    cx.default_global::<OlderHandlers>().0 = Some(Rc::new(handler));
}

/// One list item.
#[derive(Clone)]
enum Row {
    /// The room above the first message; reaching it asks for older messages.
    Top,
    /// `SessionBranchSeed`: what a branched session starts from.
    Seed,
    /// A message; the live one also carries the running turn it shows.
    Message(Arc<MessageRecord>, Option<Rc<SessionViewTurn>>),
    /// The running turn's own row, when no message carries its activity.
    Activity(Rc<SessionViewTurn>),
    Queued(Rc<SessionQueueView>),
    /// `ConversationRequestSlot`: the decision, when one waits (the row is empty otherwise).
    Request,
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
        (Row::Top, Row::Top)
        | (Row::Seed, Row::Seed)
        | (Row::Intro, Row::Intro)
        | (Row::Request, Row::Request)
        | (Row::Reserve, Row::Reserve) => true,
        (Row::Message(a, x), Row::Message(b, y)) => {
            Arc::ptr_eq(a, b) && same_turn(x.as_ref(), y.as_ref())
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

/// What one open session's transcript keeps between frames.
struct State {
    session: String,
    list: ListState,
    view: Option<Rc<SessionView>>,
    entering: Rc<HashMap<String, Entering>>,
    footer_meta: Rc<HashMap<String, FooterMeta>>,
    client: Option<butler_shell_client::ShellClient>,
    /// The message carrying the running turn.
    live_id: Option<String>,
    status_line: Option<Entity<StatusLineView>>,
    /// The chats intro shows.
    intro: bool,
    queue: Option<Rc<SessionQueueView>>,
    messages: Vec<Arc<MessageRecord>>,
    turn: Option<Rc<SessionViewTurn>>,
    live: Live,
    rows: Vec<Row>,
    /// The cursor (and its token) of the window before the first message, when one exists.
    older: Option<(i64, Option<String>)>,
    asked: Option<i64>,
    reserve: f32,
    /// The message the open decision was asked under (`ConversationRequestProvider`).
    request_source: Option<String>,
    /// The decision's row, while it shows something.
    request_ix: Option<usize>,
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
            list,
            view: None,
            entering: Rc::default(),
            footer_meta: Rc::default(),
            client: None,
            live_id: None,
            status_line: None,
            intro: false,
            queue: None,
            messages: Vec::new(),
            turn: None,
            live: Live::default(),
            rows: Vec::new(),
            older: None,
            asked: None,
            reserve: DEFAULT_RESERVE,
            request_source: None,
            request_ix: None,
            away: false,
            unread: false,
            seen: None,
            version: String::new(),
        }
    }

    /// Takes in this frame's view, queue and composer reserve; tells the list what changed.
    fn sync(
        &mut self,
        t: &TranscriptCtx,
        queue: Option<&SessionQueueView>,
        reserve: Option<f32>,
        intro: bool,
        request_source: Option<String>,
    ) {
        self.client.clone_from(&t.client);
        self.entering = t.entering.clone();
        self.footer_meta = t.footer_meta.clone();
        let view_changed = !self
            .view
            .as_ref()
            .is_some_and(|view| Rc::ptr_eq(view, &t.shared));
        let queue_changed = self.queue.as_deref() != queue;
        let intro_changed = self.intro != intro;
        self.intro = intro;
        let source_changed = self.request_source != request_source;
        self.request_source = request_source;
        if view_changed {
            self.view = Some(t.shared.clone());
        }
        if queue_changed {
            self.queue = queue.map(|queue| reuse(self.queue.as_ref(), queue.clone()));
        }
        if view_changed || queue_changed || intro_changed || source_changed || self.rows.is_empty()
        {
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
        let old = std::mem::take(&mut self.messages);
        let previous: HashMap<&str, &Arc<MessageRecord>> = old
            .iter()
            .map(|message| (message.id.as_str(), message))
            .collect();
        self.messages = collapse_assistant_attempts(&answers::with_question_answers(
            &view.messages,
            view.question_answers.as_deref().unwrap_or_default(),
        ))
        .into_iter()
        .map(|new| match previous.get(new.id.as_str()) {
            Some(kept) if Arc::ptr_eq(kept, &new) || ***kept == *new => Arc::clone(kept),
            _ => new,
        })
        .collect();
        let turn = view
            .active_turn
            .clone()
            .map(|turn| reuse(self.turn.as_ref(), turn));
        self.turn = turn;
        let info = turn_info(&view);
        let live = self.live.message(&self.messages, info.as_ref());
        self.live_id = live
            .and_then(|ix| self.messages.get(ix))
            .map(|m| m.id.clone());
        let window = &view.message_window;
        self.older = window
            .previous_cursor
            .filter(|_| window.has_more.unwrap_or(!window.complete))
            .map(|cursor| (cursor, window.previous_cursor_token.clone()));
        let mut rows = vec![Row::Top];
        if view.branch_seed.is_some() && self.older.is_none() {
            rows.push(Row::Seed);
        }
        // A request asked before Butler wrote anything gets its own row after the messages.
        let anchored = self.messages.iter().position(|message| {
            message.role != MessageRecordRole::User
                && self.request_source.as_deref() == Some(message.id.as_str())
        });
        for (ix, message) in self.messages.iter().enumerate() {
            let carried = if live == Some(ix) {
                self.turn.clone()
            } else {
                None
            };
            rows.push(Row::Message(message.clone(), carried));
            // `ConversationRequestAnchor`: the decision sits under the message it was asked in.
            if anchored == Some(ix) {
                rows.push(Row::Request);
            }
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
        if anchored.is_none() {
            rows.push(Row::Request);
        }
        if self.intro {
            rows.push(Row::Intro);
        }
        rows.push(Row::Reserve);
        splice_changes(&self.list, &self.rows, &rows);
        self.rows = rows;
        self.version = version(&self.messages);
    }

    /// `scrollToBottom`: follow the newest message again.
    fn scroll_to_bottom(&mut self) {
        self.list.set_follow_mode(FollowMode::Tail);
        self.away = false;
        self.unread = false;
        self.seen = Some(self.version.clone());
    }
}

/// The transcript: rows in the ConversationShell list surface, auto-scroll and follow-latest.
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
    let intro = intro::visible(&t.view.session_id, cx);
    let source = pending_asks(&t.view.session_id, t.view.cursors.events, window, cx)
        .and_then(|page| request_source_message(t.view, &page));
    state.update(cx, |state, cx| {
        state.sync(t, queue, reserve, intro, source);
        StatusLineView::sync(&mut state.status_line, t.view, cx);
    });
    let (list_state, away, unread) = {
        let s = state.read(cx);
        (s.list.clone(), s.away, s.unread)
    };
    // A decision's height changes with its own state (collapse, step, pending): measure it again.
    if let Some(ix) = state.read(cx).request_ix {
        list_state.remeasure_items(ix..ix + 1);
    }
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
        .child(rows)
        .children(jump)
        .into_any_element()
}

/// `ScrollToBottomButton.ts`.
fn jump_button(state: &Entity<State>, unread: bool, cx: &App) -> AnyElement {
    let text = strings(Ds::get(cx).lang());
    let (aria, latest, fresh) = (text.jump_aria, text.jump_latest, text.jump_new);
    let state = state.clone();
    ConversationScrollToBottomButton::new("transcript-jump", aria)
        .unread(unread)
        .text(if unread { fresh } else { latest })
        .on_click(move |window, cx| {
            state.update(cx, |state, _| state.scroll_to_bottom());
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
    let (row, shared, client, entering, footer_meta, live_id) = {
        let s = state.read(cx);
        (
            s.rows.get(ix).cloned(),
            s.view.clone(),
            s.client.clone(),
            s.entering.clone(),
            s.footer_meta.clone(),
            s.live_id.clone(),
        )
    };
    let (Some(row), Some(shared)) = (row, shared) else {
        return div().into_any_element();
    };
    let mut t = TranscriptCtx::new(&shared, client, entering, footer_meta);
    t.live_message = live_id.as_deref();
    t.status_line = state.read(cx).status_line.clone();
    let element = match row {
        Row::Top => return top_row(state, cx),
        // The list renders its rows while it prepaints, after the conversation scope has
        // popped: the reserve is the one `sync` took in during render.
        Row::Reserve => return div().h(px(state.read(cx).reserve)).into_any_element(),
        Row::Seed => match session_branch_seed(&t, window, cx) {
            Some(seed) => seed,
            None => return div().into_any_element(),
        },
        Row::Message(message, _) => message_row(&message, &t, window, cx),
        Row::Activity(turn) => {
            let rows: Vec<ProgressRow> = turn
                .progress
                .iter()
                .flat_map(|progress| progress.safe_progress_rows.iter())
                .cloned()
                .collect();
            match turn_activity_panel(&rows, Some(&turn.id), &t, window, cx) {
                Some(panel) => MessageRow::new("active-turn-activity", Role::Assistant)
                    .activity()
                    .child(panel)
                    .into_any_element(),
                None => div().into_any_element(),
            }
        }
        Row::Queued(queue) => queued_rows(&queue, &t, window, cx),
        Row::Request => {
            let shown = request::request_row(&t, window, cx);
            state.update(cx, |s, _| {
                s.request_ix = shown.as_ref().map(|_| ix);
            });
            match shown {
                Some(row) => row,
                None => return div().into_any_element(),
            }
        }
        Row::Intro => MessageRow::new("chats-intro", Role::Assistant)
            .bubble()
            .child(chats_intro(&t, window, cx))
            .into_any_element(),
    };
    in_column(element, cx)
}
