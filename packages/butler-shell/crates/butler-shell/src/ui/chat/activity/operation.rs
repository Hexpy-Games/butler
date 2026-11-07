//! `OperationOutputDetails`, `operation*Presentation` (output via `get_operation_output`).
mod present;
mod read;
mod structured;

use butler_ds::ui::blocks::work_activity;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Typo, Wrap};
use futures::future::BoxFuture;
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Task, Window,
};

use self::present::{Presentation, Section, present};
use super::tools::copy::text;
use crate::ui::source::agent::Jobs;

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
    read: Vec<Page>,
    phase: Phase,
    started: bool,
    task: Option<Task<()>>,
}

impl Default for Pages {
    fn default() -> Self {
        Self {
            read: Vec::new(),
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

/// `GET /turns/{turn}/operations/{request}/output?result_id&offset` on the agent worker.
pub(super) fn fetch_page(
    cx: &App,
    ids: Ids,
    offset: u64,
) -> BoxFuture<'static, Option<(String, u64, bool)>> {
    let read = Jobs::run(cx, move |client| async move {
        let raw = client
            .get_operation_output(&ids.turn, &ids.request, &ids.result, offset)
            .await
            .ok()?;
        Some((
            raw.get("content")?.as_str()?.to_owned(),
            raw.get("byte_end")?.as_u64()?,
            raw.get("complete")?.as_bool()?,
        ))
    });
    Box::pin(async move { read.await.flatten() })
}

/// Starts reading the page at `offset` into `state`.
fn load(state: &Entity<Pages>, ids: Ids, offset: u64, cx: &mut App) {
    state.update(cx, |pages, cx| {
        pages.phase = Phase::Loading;
        pages.started = true;
        let page = fetch_page(cx, ids, offset);
        pages.task = Some(cx.spawn(async move |this, cx| {
            let page = page.await;
            let _ = this.update(cx, |pages, cx| {
                match page {
                    Some((content, byte_end, complete)) => {
                        pages.read.push(Page {
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

/// OperationOutputDetails
pub(super) fn output_details(
    ids: &Ids,
    tool: Option<&str>,
    command: Option<&str>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let key = SharedString::from(format!(
        "operation-output:{}:{}:{}",
        ids.turn, ids.request, ids.result
    ));
    let state = window.use_keyed_state(key.clone(), cx, |_, _| Pages::default());
    if !state.read(cx).started {
        load(&state, ids.clone(), 0, cx);
    }
    let lang = Ds::get(cx).lang();
    let (joined, latest, phase, empty) = {
        let pages = state.read(cx);
        let latest = pages.read.last().map(|page| (page.complete, page.byte_end));
        let joined: String = pages
            .read
            .iter()
            .map(|page| page.content.as_str())
            .collect();
        (joined, latest, pages.phase, pages.read.is_empty())
    };
    if phase == Phase::Failed && empty {
        return Typo::caption(text(lang, "d.outputLoadFailed")).into_any_element();
    }
    let complete = latest.is_some_and(|(complete, _)| complete);
    let output = present(tool, &joined, complete, lang);
    let more = latest
        .filter(|(complete, _)| !complete)
        .map(|(_, byte_end)| more_button(&key, &state, ids, byte_end, phase, lang));
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
    ids: &Ids,
    byte_end: u64,
    phase: Phase,
    lang: Lang,
) -> AnyElement {
    let loading = phase == Phase::Loading;
    let (state, ids) = (state.clone(), ids.clone());
    let label = text(lang, if loading { "d.loading" } else { "d.moreOutput" });
    let mut button = Button::new(SharedString::from(format!("{key}-more")))
        .variant(Variant::Borderless)
        .size(Size::Xs)
        .text(label)
        .on_click(move |_, _, cx| {
            load(&state, ids.clone(), byte_end, cx);
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
