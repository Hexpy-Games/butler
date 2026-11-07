//! `OperationOutputDetails`, `operation*Presentation` (output via `get_operation_output`).
mod present;
mod read;
mod structured;

use butler_ds::ui::blocks::work_activity;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Typo, Wrap};
use butler_shell_client::ShellClient;
use futures::channel::oneshot;
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Task, Window, div,
};

use self::present::{Presentation, Section, present};
use super::tools::copy::text;
use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::{ProgressRow, SessionView};

/// One page of a stored operation output.
struct Page {
    content: String,
    byte_end: u64,
    complete: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Loading,
    Ready,
    Failed,
}

/// The pages read so far (the `pages` and `state` of OperationOutputDetails).
pub(super) struct Pages {
    pages: Vec<Page>,
    phase: Phase,
    started: bool,
    task: Option<Task<()>>,
}

impl Default for Pages {
    fn default() -> Self {
        Self {
            pages: Vec::new(),
            phase: Phase::Loading,
            started: false,
            task: None,
        }
    }
}

/// The operation a page belongs to.
#[derive(Clone)]
pub(super) struct Ids {
    pub(super) turn: String,
    pub(super) request: String,
    pub(super) result: String,
}

fn read_blocking(client: &ShellClient, ids: &Ids, offset: u64) -> Option<Page> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    let raw = runtime
        .block_on(client.get_operation_output(&ids.turn, &ids.request, &ids.result, offset))
        .ok()?;
    Some(Page {
        content: raw.get("content")?.as_str()?.to_owned(),
        byte_end: raw.get("byte_end")?.as_u64()?,
        complete: raw.get("complete")?.as_bool()?,
    })
}

/// `GET /turns/{turn}/operations/{request}/output?result_id&offset` on a thread of its own
/// (the client needs a tokio runtime; gpui's executor has none).
pub(super) async fn fetch_page(
    client: Option<ShellClient>,
    ids: Ids,
    offset: u64,
) -> Option<(String, u64, bool)> {
    let (send, receive) = oneshot::channel::<Option<Page>>();
    match client {
        Some(client) => {
            let _ = std::thread::Builder::new().spawn(move || {
                let _ = send.send(read_blocking(&client, &ids, offset));
            });
        }
        None => {
            let _ = send.send(None);
        }
    }
    let page = receive.await.ok().flatten()?;
    Some((page.content, page.byte_end, page.complete))
}

/// Starts reading the page at `offset` into `state`.
fn load(state: &Entity<Pages>, client: Option<ShellClient>, ids: Ids, offset: u64, cx: &mut App) {
    state.update(cx, |pages, cx| {
        pages.phase = Phase::Loading;
        pages.started = true;
        pages.task = Some(cx.spawn(async move |this, cx| {
            let page = fetch_page(client, ids, offset).await;
            let _ = this.update(cx, |pages, cx| {
                match page {
                    Some((content, byte_end, complete)) => {
                        pages.pages.push(Page {
                            content,
                            byte_end,
                            complete,
                        });
                        pages.phase = Phase::Ready;
                    }
                    None => pages.phase = Phase::Failed,
                }
                cx.notify();
            });
        }));
    });
}

/// The operation's progress row, for the result id its output is read with.
fn find_row<'a>(view: &'a SessionView, turn: &str, request: &str) -> Option<&'a ProgressRow> {
    let history = view
        .activity_history
        .iter()
        .flatten()
        .flat_map(|item| item.rows.iter());
    let live = view
        .messages
        .iter()
        .flat_map(|message| message.turn_activity_rows.iter().flatten());
    let blocks = view
        .messages
        .iter()
        .flat_map(|message| message.work_blocks.iter().flatten())
        .flat_map(|block| block.rows.iter());
    history.chain(live).chain(blocks).find(|row| {
        row.turn_id.as_deref().is_none_or(|id| id == turn)
            && row.tool_call_id.as_deref() == Some(request)
            && row.tool_result_id.is_some()
    })
}

/// The paged output of one operation.
#[allow(dead_code, reason = "P2 shell-wave: wired by Opus at wave integration")]
pub(crate) fn operation_output(
    turn_id: &str,
    request_id: &str,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let Some(row) = find_row(t.view, turn_id, request_id) else {
        return div().into_any_element();
    };
    let Some(result_id) = row.tool_result_id.as_deref() else {
        return div().into_any_element();
    };
    let ids = Ids {
        turn: turn_id.to_owned(),
        request: request_id.to_owned(),
        result: result_id.to_owned(),
    };
    let command = (row.safe_tool_name.as_deref() == Some("run_command"))
        .then_some(row.safe_input_label.as_deref())
        .flatten();
    output_details(&ids, row.safe_tool_name.as_deref(), command, t, window, cx)
}

/// OperationOutputDetails
pub(super) fn output_details(
    ids: &Ids,
    tool: Option<&str>,
    command: Option<&str>,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let key = SharedString::from(format!(
        "operation-output:{}:{}:{}",
        ids.turn, ids.request, ids.result
    ));
    let state = window.use_keyed_state(key.clone(), cx, |_, _| Pages::default());
    if !state.read(cx).started {
        load(&state, t.client.clone(), ids.clone(), 0, cx);
    }
    let lang = Ds::get(cx).lang();
    let (joined, latest, phase, empty) = {
        let pages = state.read(cx);
        let latest = pages
            .pages
            .last()
            .map(|page| (page.complete, page.byte_end));
        let joined: String = pages
            .pages
            .iter()
            .map(|page| page.content.as_str())
            .collect();
        (joined, latest, pages.phase, pages.pages.is_empty())
    };
    if phase == Phase::Failed && empty {
        return Typo::caption(text(lang, "d.outputLoadFailed")).into_any_element();
    }
    let complete = latest.is_some_and(|(complete, _)| complete);
    let output = present(tool, &joined, complete, lang);
    let more = latest
        .filter(|(complete, _)| !complete)
        .map(|(_, byte_end)| more_button(&key, &state, t, ids, byte_end, phase, lang));
    let mut stack = Stack::new().gap(Space::Xs);
    if let Some(execution) = execution(&output, command, lang) {
        stack = stack.children(execution);
    }
    stack
        .child(body(output, cx))
        .children(more)
        .into_any_element()
}

/// `{Execution}: command` and `{Result}:`, when the output belongs to a command.
fn execution(output: &Presentation, command: Option<&str>, lang: Lang) -> Option<[AnyElement; 2]> {
    let own = match output {
        Presentation::Command { command, .. } => command.as_deref(),
        _ => None,
    };
    let shown = own.or(command)?;
    Some([
        Typo::caption(format!("{}: {shown}", text(lang, "st.execution")))
            .wrap(Wrap::Pre)
            .into_any_element(),
        Typo::caption(format!("{}:", text(lang, "st.result"))).into_any_element(),
    ])
}

fn more_button(
    key: &SharedString,
    state: &Entity<Pages>,
    t: &TranscriptCtx,
    ids: &Ids,
    byte_end: u64,
    phase: Phase,
    lang: Lang,
) -> AnyElement {
    let loading = phase == Phase::Loading;
    let (state, client, ids) = (state.clone(), t.client.clone(), ids.clone());
    let label = text(lang, if loading { "d.loading" } else { "d.moreOutput" });
    let mut button = Button::new(SharedString::from(format!("{key}-more")))
        .variant(Variant::Borderless)
        .size(Size::Xs)
        .text(label)
        .on_click(move |_, _, cx| {
            load(&state, client.clone(), ids.clone(), byte_end, cx);
            state.update(cx, |_, cx| cx.notify());
        });
    if loading {
        button = button.disabled();
    }
    button.into_any_element()
}

fn caption(value: &str) -> AnyElement {
    Typo::caption(value.to_owned()).into_any_element()
}

fn code(content: &str, cx: &App) -> AnyElement {
    work_activity::output(content.to_owned(), cx).into_any_element()
}

fn section(section: &Section, cx: &App) -> AnyElement {
    let mut stack = Stack::new().gap(Space::Xs).child(caption(&section.title));
    if let Some(message) = section.message.as_deref().filter(|m| !m.is_empty()) {
        stack = stack.child(caption(message));
    }
    if let Some(content) = section.content.as_deref().filter(|c| !c.is_empty()) {
        stack = stack.child(code(content, cx));
    }
    stack.into_any_element()
}

fn body(output: Presentation, cx: &App) -> AnyElement {
    match output {
        Presentation::Summary(content) => caption(&content),
        Presentation::Code(content) => code(&content, cx),
        Presentation::Sections { summary, sections } => Stack::new()
            .gap(Space::Xs)
            .child(caption(&summary))
            .children(sections.iter().map(|item| section(item, cx)))
            .into_any_element(),
        Presentation::Command {
            summary, content, ..
        } => {
            let mut stack = Stack::new().gap(Space::Xs).child(caption(&summary));
            if let Some(content) = content.filter(|content| !content.is_empty()) {
                stack = stack.child(code(&content, cx));
            }
            stack.into_any_element()
        }
    }
}
