//! The sign-in screen (`FirstRunSignIn.tsx`) and its card (`ChatGptSignInCard.tsx`, first-run
//! form).
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::blocks::setup_wizard_step_card::{SetupWizardStepAction, SetupWizardStepCard};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::Justify;
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::tooltip::Tooltip;
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, SharedString, Window};

use super::copy::{Words, words};
use super::{Flow, Phase, SignIn};
use crate::ui::Icon;
use crate::ui::onboarding::Onboarding;
use crate::ui::onboarding::card::step_card;
use crate::ui::onboarding::copy::words as shared;
use crate::ui::settings::controls::provider_mark;

const NAME: &str = "ChatGPT";

/// The screen's reading of the account and the flow.
struct Flags {
    waiting: bool,
    signed: bool,
    off: bool,
}

impl SignIn {
    /// The values of `FirstRunSignIn`.
    fn flags(&self) -> Flags {
        let active = matches!(self.phase, Phase::Starting | Phase::Waiting);
        let failed = matches!(self.phase, Phase::Failed | Phase::TimedOut);
        let quiet = !active && !failed;
        let status = self.account_status();
        let flow = self.flow.as_ref();
        let plan = flow.and_then(|flow| flow.plan_enabled);
        let finished = |flow: &Flow| {
            (flow.status == "completed" && plan != Some(false)) || flow.status == "profile_exists"
        };
        Flags {
            waiting: self.phase == Phase::Waiting,
            signed: quiet && (status == "signed_in" || flow.is_some_and(finished)),
            off: quiet && (status == "plan_off" || plan == Some(false)),
        }
    }
}

pub(crate) fn screen(
    view: &Onboarding,
    _window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let copy = words(view.lang);
    let state = view.sign_in.read(cx);
    let Flags {
        waiting,
        signed,
        off,
    } = state.flags();
    let phase = state.phase.name();
    let body = if off {
        turn_on(copy, cx)
    } else {
        card(state, copy, cx)
    };
    let (connected, committing) = {
        let commit = view.commit.read(cx);
        (commit.connected().is_some(), commit.committing())
    };
    let key = format!(
        "signin:{}",
        if off {
            "off"
        } else if signed {
            "signed"
        } else {
            phase
        }
    );
    let mut elements = vec![body];
    if view.commit.read(cx).failed() {
        elements.push(finish_failed(view, cx));
    }
    let title = if off {
        copy.plan_off_title.to_owned()
    } else if signed {
        (copy.ready_title)(NAME)
    } else {
        (copy.title)(NAME)
    };
    let mut step = step_card(view, title, elements, cx)
        .content_key(key)
        .on_back(
            shared(view.lang).back,
            cx.listener(|view, _, _, cx| view.back_to_list(cx)),
        );
    if off {
        step = step.description(copy.plan_off_body);
    } else if !signed {
        step = step.description(copy.body);
    }
    footer(
        step,
        copy,
        (waiting, connected, !signed || off, committing),
        cx,
    )
}

/// Cancel while waiting, and Next: connect, or open the reply step when already connected.
fn footer(
    mut step: SetupWizardStepCard,
    copy: &Words,
    (waiting, connected, blocked, committing): (bool, bool, bool, bool),
    cx: &Context<Onboarding>,
) -> AnyElement {
    if waiting {
        step = step.action(
            SetupWizardStepAction::new("first-run-signin-cancel", copy.cancel).on_click(
                cx.listener(|view, _, _, cx| {
                    view.sign_in
                        .update(cx, |sign_in, cx| sign_in.cancel(Phase::Cancelled, cx));
                }),
            ),
        );
    }
    let mut next = SetupWizardStepAction::new("first-run-signin-next", copy.next)
        .forward()
        .on_click(cx.listener(move |view, _, _, cx| {
            if connected {
                view.open_reply(cx);
            } else {
                view.connect_chatgpt(cx);
            }
        }));
    let mut tip = Tooltip::new("first-run-signin-next-tip");
    if blocked {
        tip = tip.label(copy.connect_first);
    }
    if blocked || committing {
        next = next.disabled();
    }
    step.action(tip.child(next)).into_any_element()
}

/// Plan use is off: the Turn on button.
fn turn_on(copy: &Words, cx: &Context<Onboarding>) -> AnyElement {
    let turn_on = Button::new("first-run-signin-turn-on")
        .size(Size::Sm)
        .text(copy.turn_on)
        .on_click(cx.listener(|view, _, _, cx| {
            view.sign_in
                .update(cx, |sign_in, cx| sign_in.start("enable_plan", false, cx));
        }));
    button::container(Size::Sm)
        .justify(Justify::End)
        .child(turn_on)
        .into_any_element()
}

/// The commit failed: the notice with Retry.
fn finish_failed(view: &Onboarding, cx: &Context<Onboarding>) -> AnyElement {
    let copy = shared(view.lang);
    let retry = Button::new("first-run-signin-retry")
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(copy.retry)
        .on_click(cx.listener(|view, _, _, cx| view.retry_commit(cx)));
    Notice::new(NoticeTone::Error, copy.finish_failed)
        .icon(icon(Icon::CircleAlert, IconSize::Md, Ds::get(cx)))
        .action(retry)
        .into_any_element()
}

/// `ChatGptSignInCard`. Its plan-off state never shows here: the screen shows Turn on instead.
fn card(state: &SignIn, copy: &Words, cx: &Context<Onboarding>) -> AnyElement {
    let waiting = matches!(state.phase, Phase::Waiting | Phase::Starting);
    let failed = state.phase == Phase::Failed;
    let timed_out = state.phase == Phase::TimedOut;
    let flow = state.flow.as_ref();
    let signed = !waiting
        && !failed
        && !timed_out
        && match state.account {
            Some(_) => state.account_status() == "signed_in",
            None => flow.is_some_and(Flow::signed_in),
        };
    let again = !signed
        && matches!(
            state.account_status(),
            "sign_in_required" | "legacy_sign_in_required"
        );
    let line = line(state, copy, (waiting, failed, timed_out, signed, again));
    let actions = actions(
        state,
        copy,
        (waiting, failed || timed_out, signed, again),
        cx,
    );
    let tone = if failed {
        NoticeTone::Error
    } else {
        NoticeTone::Neutral
    };
    let glyph = if waiting {
        Spinner::new("first-run-signin-spinner")
            .size(16.)
            .into_any_element()
    } else if signed {
        icon(Icon::CheckCircle2, IconSize::Md, Ds::get(cx)).into_any_element()
    } else if failed || timed_out || again {
        icon(Icon::AlertCircle, IconSize::Md, Ds::get(cx)).into_any_element()
    } else {
        provider_mark("openai", None, false)
    };
    // ANIM-MIGRATE(RollingSwap of the status line when it changes)
    Notice::new(tone, line)
        .icon(glyph)
        .action(actions)
        .into_any_element()
}

/// The card's status line.
fn line(
    state: &SignIn,
    copy: &Words,
    (waiting, failed, timed_out, signed, again): (bool, bool, bool, bool, bool),
) -> SharedString {
    let text = if waiting {
        copy.pending.to_owned()
    } else if timed_out {
        copy.timed_out.to_owned()
    } else if failed {
        match state.flow.as_ref().and_then(|flow| flow.error.as_deref()) {
            Some("oauth_account_mismatch") => copy.account_mismatch.to_owned(),
            Some("oauth_discovery_unavailable") => copy.discovery_offline.to_owned(),
            _ => copy.failed.to_owned(),
        }
    } else if signed {
        let label = state.account_text("label").or_else(|| {
            state
                .flow
                .as_ref()
                .and_then(|flow| flow.label.as_deref())
                .filter(|label| label.contains('@'))
        });
        [Some(copy.complete), label]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ")
    } else if again {
        copy.sign_in_again_hint.to_owned()
    } else {
        String::new()
    };
    text.into()
}

/// The card's buttons.
fn actions(
    state: &SignIn,
    copy: &Words,
    (waiting, ended, signed, again): (bool, bool, bool, bool),
    cx: &Context<Onboarding>,
) -> AnyElement {
    let mut row = button::container(Size::Sm).justify(Justify::End);
    if waiting {
        let url = state.flow.as_ref().and_then(|flow| flow.auth_url.clone());
        if let Some(url) = url.clone() {
            row = row
                .child(CopyButton::new("first-run-signin-copy", copy.copy, copy.copied).text(url));
        }
        let mut open = Button::new("first-run-signin-open")
            .size(Size::Sm)
            .icon_start(icon(Icon::Globe2, IconSize::Sm, Ds::get(cx)))
            .text(copy.open);
        open = match url {
            Some(url) => open.on_click(move |_, _, cx| cx.open_url(&url)),
            None => open.disabled(),
        };
        return row.child(open).into_any_element();
    }
    if ended {
        let restart = Button::new("first-run-signin-restart")
            .size(Size::Sm)
            .text(copy.restart)
            .on_click(cx.listener(|view, _, _, cx| {
                view.sign_in
                    .update(cx, |sign_in, cx| sign_in.start("default", true, cx));
            }));
        return row.child(restart).into_any_element();
    }
    if signed || again {
        row = row.child(
            Button::new("first-run-signin-other")
                .size(Size::Sm)
                .variant(Variant::Inline)
                .text(copy.other_account)
                .on_click(cx.listener(|view, _, _, cx| {
                    view.sign_in
                        .update(cx, |sign_in, cx| sign_in.start("new_account", false, cx));
                })),
        );
    }
    if !signed {
        row = row.child(
            Button::new("first-run-signin-go")
                .size(Size::Sm)
                .text(copy.plan_continue)
                .on_click(cx.listener(|view, _, _, cx| {
                    view.sign_in
                        .update(cx, |sign_in, cx| sign_in.start("default", false, cx));
                })),
        );
    }
    row.into_any_element()
}
