//! The App's own lifecycle screens (`lifecycle-assets/copy.json`, `AppBootState`,
//! `AgentStatusNotice`): the boot state while the onboarding gate waits, the quit card, and the
//! notice above the conversation when the Agent is stopped, restarting or failed.
//!
//! The frame renders each fn inside an update of the runtime entity, so these fns read the
//! `runtime` they get and never `lifecycle::runtime(cx)` again (only click handlers do, later).

mod copy;
mod update;

pub(crate) use update::update_choice;

use std::time::Duration;

use butler_ds::tokens::{Color, Length};
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::motion;
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::thinking_mark::{ButlerThinkingMark, MarkState, MarkTheme};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::{TextAlign, Tone, Typo};
use gpui::{
    AnyElement, App, Context, IntoElement as _, ParentElement as _, Styled as _, Window, div,
};

use self::copy::words;
use crate::lifecycle::supervisor::{AgentState, Supervisor, SupervisorError};
use crate::lifecycle::{self, AgentRuntime};
use crate::ui::Icon;

/// `lifecycle-assets/copy.json` slow hint: shown once the quit has run this long.
const SLOW_AFTER: Duration = Duration::from_secs(4);

/// The window-filling page the boot and quit cards sit on, centred: a flex column, since the
/// card's `fill` grows only inside one.
fn page(content: impl gpui::IntoElement, cx: &App) -> AnyElement {
    div()
        .size_full()
        .flex()
        .flex_col()
        .bg(Ds::get(cx).color(Color::Background))
        .child(
            Stack::new()
                .fill()
                .justify(Justify::Center)
                .cross(Cross::Center)
                .gap(Space::Md)
                .child(content),
        )
        .into_any_element()
}

/// `lifecycle.html`'s card: the mark, then the title and its line. The mark runs while the Agent
/// starts and rests once it failed.
fn card(working: bool, title: &'static str, line: &'static str, cx: &App) -> Stack {
    let theme = if Ds::get(cx).dark() {
        MarkTheme::Dark
    } else {
        MarkTheme::Light
    };
    let state = if working {
        MarkState::Working
    } else {
        MarkState::Idle
    };
    Stack::new()
        .gap(Space::Md)
        .cross(Cross::Center)
        .child(
            ButlerThinkingMark::new("boot-mark")
                .size(IconSize::Xxxl)
                .theme(theme)
                .state(state),
        )
        .child(
            Stack::new()
                .gap(Space::Xs)
                .cross(Cross::Center)
                .child(Typo::app_title(title).align(TextAlign::Center))
                .child(
                    Typo::body(line)
                        .tone(Tone::Secondary)
                        .align(TextAlign::Center),
                ),
        )
}

/// Starting, failed (Open log, Try again), or a plain spinner (`AppBootState`).
pub(crate) fn boot(
    runtime: &AgentRuntime,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let _ = window;
    let words = words(lang);
    let failed = matches!(
        runtime.state,
        AgentState::Failed | AgentState::RestartFailed
    ) || runtime.error.is_some();
    if failed {
        let stopped = runtime.error == Some(SupervisorError::Stopped);
        let log = runtime.data.join("logs");
        let actions = Stack::row()
            .gap(Space::Sm)
            .justify(Justify::Center)
            .child(
                Button::new("boot-open-log")
                    .variant(Variant::Secondary)
                    .size(Size::Sm)
                    .text(words.open_log)
                    .on_click(move |_, _, cx| cx.open_with_system(&log)),
            )
            .child(
                Button::new("boot-retry")
                    .size(Size::Sm)
                    .text(words.retry)
                    .on_click(move |_, _, cx| {
                        if stopped {
                            lifecycle::command(cx, Supervisor::resume);
                        } else {
                            lifecycle::ensure_ready(cx);
                        }
                    }),
            );
        let failed = card(false, words.failed, words.failed_reason, cx).child(actions);
        return page(failed, cx);
    }
    if matches!(runtime.state, AgentState::Starting | AgentState::Restarting) {
        return page(card(true, words.starting, words.starting_stage, cx), cx);
    }
    page(Spinner::new("boot-spinner"), cx)
}

/// The one-shot timer behind the quit card's slow hint.
struct Slow {
    shown: bool,
}

impl Slow {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let this = cx.weak_entity();
        motion::delay(window, cx, SLOW_AFTER, move |_, cx| {
            let _ = this.update(cx, |slow, cx| {
                slow.shown = true;
                cx.notify();
            });
        });
        Self { shown: false }
    }
}

/// "Quitting Butler…", then the slow hint after 4 s.
pub(crate) fn quit(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let words = words(lang);
    let slow = window
        .use_keyed_state("quit-slow", cx, Slow::new)
        .read(cx)
        .shown;
    let mut card = Stack::new()
        .gap(Space::Md)
        .cross(Cross::Center)
        .child(Spinner::new("quit-spinner"))
        .child(Typo::label(words.quitting));
    if slow {
        card = card.child(Typo::body(words.slow).tone(Tone::Secondary));
    }
    page(card, cx)
}

/// `startAgent` with `notifyError(error, feedback.agentStartFailed)`: the failure toasts the
/// fallback copy; success leaves the notice to `AgentRuntime::state`.
fn start(failed: &'static str, cx: &mut App) {
    let started = lifecycle::resume(cx);
    cx.spawn(async move |cx| {
        if started.await.is_err() {
            cx.update(|cx| {
                toast::show(cx, Toast::error(failed));
            });
        }
    })
    .detach();
}

/// The Agent stopped, restarting or failed, with Start or Retry.
pub(crate) fn agent_notice(
    runtime: &AgentRuntime,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = window;
    let words = words(lang);
    let (tone, message, action) = match runtime.state {
        AgentState::Stopped => (NoticeTone::Warning, words.agent_stopped, words.agent_start),
        AgentState::Restarting => (NoticeTone::Info, words.agent_restarting, ""),
        AgentState::RestartFailed => (
            NoticeTone::Error,
            words.agent_restart_failed,
            words.notice_retry,
        ),
        _ => return None,
    };
    let ds = Ds::get(cx);
    let lead: AnyElement = if runtime.state == AgentState::Restarting {
        Spinner::new("agent-notice-spinner").into_any_element()
    } else {
        icon(Icon::AlertCircle, IconSize::Lg, ds).into_any_element()
    };
    let mut notice = Notice::new(tone, message).icon(lead);
    if !action.is_empty() {
        let failed = words.agent_start_failed;
        let mut button = Button::new("agent-notice-action")
            .variant(Variant::Outline)
            .size(butler_ds::ui::button::Size::Sm)
            .text(action)
            .on_click(move |_, _, cx| start(failed, cx));
        if runtime.resuming {
            button = button.disabled();
        }
        notice = notice.action(button);
    }
    Some(
        div()
            .px(ds.len(Length::SpaceMd))
            .py(ds.len(Length::SpaceSm))
            .child(notice)
            .into_any_element(),
    )
}
