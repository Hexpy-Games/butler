//! `ChatGptSignInCard.tsx` with `useChatGptAccount`, `useSignIn` and `chatGptActions`
//! (`signOutChatGpt`): the explicit-action ChatGPT sign-in. Starting it opens the system browser
//! at the agent flow's `auth_url`; the card then polls the flow until the browser finishes.
//! F4: React also re-reads the account on window focus and on `setup.chatgpt_account_changed`;
//! here it reads on open and after its own actions.
use std::time::{Duration, Instant};

use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::Justify;
use butler_ds::ui::skeleton::{Height, Skeleton, Width};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::toast::{self, Action, Toast};
use butler_shell_client::Error;
use gpui::{AnyElement, Context, IntoElement, ParentElement as _, Render, SharedString, Window};
use serde::Deserialize;
use serde_json::json;

use super::copy::{Words, words};
use crate::ui::Icon;
use crate::ui::settings::SectionCtx;
use crate::ui::settings::controls::provider_mark;
use crate::ui::settings::state::{fetch, fetch_if};

const POLL: Duration = Duration::from_secs(1); // useSignIn.ts SIGN_IN_POLL_MS
const TIMEOUT: Duration = Duration::from_mins(5); // useSignIn.ts SIGN_IN_TIMEOUT_MS
const MANAGE_USAGE_URL: &str = "https://chatgpt.com/settings/usage"; // chatGptActions.ts

/// `SignInPhase`
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    Starting,
    Waiting,
    Cancelled,
    TimedOut,
    Failed,
}

/// `OpenAIOAuthLoginResult`, merged over the flow's earlier answers.
#[derive(Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct SignInFlow {
    flow_id: Option<String>,
    auth_url: Option<String>,
    error: Option<String>,
    label: Option<String>,
    plan_enabled: Option<bool>,
    status: String,
}

impl SignInFlow {
    fn merge(&mut self, next: Self) {
        self.flow_id = next.flow_id.or(self.flow_id.take());
        self.auth_url = next.auth_url.or(self.auth_url.take());
        self.error = next.error.or(self.error.take());
        self.label = next.label.or(self.label.take());
        self.plan_enabled = next.plan_enabled.or(self.plan_enabled);
        if !next.status.is_empty() {
            self.status = next.status;
        }
    }

    fn signed_in(&self) -> bool {
        signed_in_status(&self.status)
    }
}

fn signed_in_status(status: &str) -> bool {
    matches!(status, "completed" | "profile_exists")
}

/// `ChatGptAccountView`
#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct Account {
    status: String,
    label: Option<String>,
}

#[derive(Deserialize)]
struct SignedOut {
    revoked: bool,
    account: Account,
}

pub(super) struct ChatGptCard {
    ctx: SectionCtx,
    /// `editing`: an existing ChatGPT model is being edited.
    editing: bool,
    account: Option<Account>,
    phase: Phase,
    flow: Option<SignInFlow>,
    /// `run`: a newer start or cancel makes older answers stale.
    run: u64,
    /// The `auth_url` already opened in the browser.
    opened: Option<String>,
}

impl ChatGptCard {
    pub(super) fn new(ctx: SectionCtx, editing: bool, cx: &mut Context<Self>) -> Self {
        let card = Self {
            ctx,
            editing,
            account: None,
            phase: Phase::Idle,
            flow: None,
            run: 0,
            opened: None,
        };
        Self::refresh_account(cx);
        card
    }

    /// `oauthReady`
    pub(super) fn ready(&self) -> bool {
        self.phase == Phase::Idle
            && match &self.account {
                Some(account) => account.status == "signed_in",
                None => self.flow.as_ref().is_some_and(SignInFlow::signed_in),
            }
    }

    fn refresh_account(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.get_chat_gpt_account().await },
            |this: &mut Self, result: Result<Account, Error>, _| {
                if let Ok(account) = result {
                    this.account = Some(account);
                }
            },
        );
    }

    /// `startSignIn`: opens the browser at the flow's URL once it answers.
    pub(super) fn start(&mut self, kind: &'static str, force: bool, cx: &mut Context<Self>) {
        self.run += 1;
        let id = self.run;
        self.phase = Phase::Starting;
        self.flow = None;
        self.opened = None;
        cx.notify();
        let body = if force {
            json!({ "kind": kind, "force": true })
        } else {
            json!({ "kind": kind })
        };
        fetch(
            cx,
            move |client| async move { client.start_setup_oauth(&body).await },
            move |this: &mut Self, result: Result<SignInFlow, Error>, cx| match result {
                Ok(flow) => this.settle(id, flow, cx),
                Err(_) if id == this.run => this.phase = Phase::Failed,
                Err(_) => {}
            },
        );
    }

    /// `settle`: merge an answer of the flow and move the phase.
    fn settle(&mut self, id: u64, result: SignInFlow, cx: &mut Context<Self>) {
        if id != self.run {
            return;
        }
        let mut flow = self.flow.take().unwrap_or_default();
        flow.merge(result);
        if let Some(url) = flow.auth_url.clone()
            && self.opened.as_deref() != Some(url.as_str())
        {
            cx.open_url(&url);
            self.opened = Some(url);
        }
        let status = flow.status.clone();
        let error = flow.error.clone();
        self.flow = Some(flow);
        match status.as_str() {
            "completed" | "profile_exists" => {
                self.run += 1;
                self.phase = Phase::Idle;
                self.signed_in(cx);
            }
            "cancelled" | "failed" => {
                self.phase = match error.as_deref() {
                    Some("oauth_timeout") => Phase::TimedOut,
                    Some("oauth_denied") => Phase::Idle,
                    _ if status == "cancelled" => Phase::Cancelled,
                    _ => Phase::Failed,
                };
            }
            "starting" | "pending" if self.phase != Phase::Waiting => {
                self.phase = Phase::Waiting;
                Self::schedule_poll(id, Instant::now(), cx);
            }
            _ => {}
        }
    }

    /// `onSignedIn`: the account and the catalog changed.
    fn signed_in(&mut self, cx: &mut Context<Self>) {
        Self::refresh_account(cx);
        self.ctx.reload_catalog(cx);
    }

    fn schedule_poll(id: u64, started: Instant, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            butler_ds::ui::motion::sleep(cx.background_executor(), POLL).await;
            let _ = this.update(cx, |this, cx| this.poll(id, started, cx));
        })
        .detach();
    }

    /// `useSignInPolling`: one read per second while waiting, until the timeout.
    fn poll(&mut self, id: u64, started: Instant, cx: &mut Context<Self>) {
        if id != self.run || self.phase != Phase::Waiting {
            return;
        }
        if started.elapsed() > TIMEOUT {
            self.cancel(Phase::TimedOut, cx);
            return;
        }
        let Some(flow_id) = self.flow.as_ref().and_then(|flow| flow.flow_id.clone()) else {
            return;
        };
        fetch_if(
            cx,
            move |client| async move { client.get_setup_oauth_flow(&flow_id).await },
            move |this: &mut Self, result: Result<SignInFlow, Error>, cx| {
                let before = (this.flow.clone(), this.phase, this.run);
                if let Ok(flow) = result {
                    this.settle(id, flow, cx);
                }
                if this.run == id && this.phase == Phase::Waiting {
                    Self::schedule_poll(id, started, cx);
                }
                (this.flow.as_ref(), this.phase, this.run)
                    != (before.0.as_ref(), before.1, before.2)
            },
        );
    }

    /// `cancel`: a cancel that lands after the code exchange answers `completed`, and the
    /// sign-in went through.
    fn cancel(&mut self, reason: Phase, cx: &mut Context<Self>) {
        self.run += 1;
        let id = self.run;
        self.phase = reason;
        cx.notify();
        let Some(flow_id) = self.flow.as_ref().and_then(|flow| flow.flow_id.clone()) else {
            return;
        };
        fetch(
            cx,
            move |client| async move { client.cancel_setup_oauth(&flow_id).await },
            move |this: &mut Self, result: Result<SignInFlow, Error>, cx| {
                if this.run == id
                    && let Ok(flow) = result
                    && flow.signed_in()
                {
                    this.flow
                        .get_or_insert_with(SignInFlow::default)
                        .merge(flow);
                    this.phase = Phase::Idle;
                    this.signed_in(cx);
                }
            },
        );
    }

    /// `leave`: a pending sign-in is cancelled.
    fn leave(&mut self, cx: &mut Context<Self>) {
        if matches!(self.phase, Phase::Waiting | Phase::Starting) {
            self.cancel(Phase::Cancelled, cx);
        }
        self.run += 1;
        self.phase = Phase::Idle;
    }

    /// `signOutChatGpt`, then `leave` and the new account.
    fn sign_out(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.sign_out_chat_gpt().await },
            |this: &mut Self, result: Result<SignedOut, Error>, cx| {
                let Ok(out) = result else { return };
                let copy = words(Ds::get(cx).lang());
                this.ctx.reload_catalog(cx);
                toast::show(cx, Toast::message(copy.signed_out));
                if !out.revoked {
                    let manage = Action::new(copy.manage_usage, |cx| cx.open_url(MANAGE_USAGE_URL));
                    toast::show(cx, Toast::message(copy.revoke_unconfirmed).action(manage));
                }
                this.leave(cx);
                this.account = Some(out.account);
            },
        );
    }
}

/// The derived flags of `ChatGptSignInCard`.
struct Flags {
    phase: Phase,
    off: bool,
    signed: bool,
    again: bool,
}

impl Flags {
    fn waiting(&self) -> bool {
        matches!(self.phase, Phase::Waiting | Phase::Starting)
    }

    fn failed(&self) -> bool {
        self.phase == Phase::Failed
    }

    fn timed_out(&self) -> bool {
        self.phase == Phase::TimedOut
    }
}

impl ChatGptCard {
    fn flags(&self) -> Flags {
        let waiting = matches!(self.phase, Phase::Waiting | Phase::Starting);
        let failed = self.phase == Phase::Failed;
        let timed_out = self.phase == Phase::TimedOut;
        let quiet = !waiting && !failed && !timed_out;
        let account = self.account.as_ref();
        let flow = self.flow.as_ref();
        let off = quiet
            && (account.is_some_and(|account| account.status == "plan_off")
                || flow.and_then(|flow| flow.plan_enabled) == Some(false));
        let signed = !off
            && quiet
            && match account {
                Some(account) => account.status == "signed_in",
                None => flow.is_some_and(SignInFlow::signed_in),
            };
        let again = !signed
            && (off
                || self.editing
                || account.is_some_and(|account| {
                    matches!(
                        account.status.as_str(),
                        "sign_in_required" | "legacy_sign_in_required"
                    )
                }));
        Flags {
            phase: self.phase,
            off,
            signed,
            again,
        }
    }

    /// The status line of the card.
    fn line(&self, flags: &Flags, copy: &Words) -> String {
        let flow = self.flow.as_ref();
        if flags.waiting() {
            copy.sign_in_pending.to_owned()
        } else if flags.timed_out() {
            copy.sign_in_timed_out.to_owned()
        } else if flags.failed() {
            match flow.and_then(|flow| flow.error.as_deref()) {
                Some("oauth_account_mismatch") => copy.account_mismatch.to_owned(),
                Some("oauth_discovery_unavailable") => copy.discovery_offline.to_owned(),
                _ => copy.sign_in_failed.to_owned(),
            }
        } else if flags.off {
            copy.plan_off.to_owned()
        } else if flags.signed {
            let label = self
                .account
                .as_ref()
                .and_then(|account| account.label.clone())
                .or_else(|| {
                    flow.and_then(|flow| flow.label.clone())
                        .filter(|label| label.contains('@'))
                });
            [Some(copy.sign_in_complete.to_owned()), label]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · ")
        } else if flags.again {
            copy.sign_in_again_hint.to_owned()
        } else {
            copy.sign_in_idle.to_owned()
        }
    }

    fn glyph(flags: &Flags, cx: &Context<Self>) -> AnyElement {
        let ds = Ds::get(cx);
        if flags.waiting() {
            Spinner::new("chatgpt-sign-in-spinner")
                .size(16.)
                .into_any_element()
        } else if flags.signed {
            icon(Icon::CheckCircle2, IconSize::Md, ds).into_any_element()
        } else if flags.failed() || flags.timed_out() || flags.again {
            icon(Icon::AlertCircle, IconSize::Md, ds).into_any_element()
        } else {
            provider_mark("openai", None, false)
        }
    }

    fn actions(&self, flags: &Flags, copy: &Words, cx: &mut Context<Self>) -> AnyElement {
        let url = self.flow.as_ref().and_then(|flow| flow.auth_url.clone());
        let mut row = button::container(Size::Sm).justify(Justify::End);
        if flags.waiting() {
            if let Some(url) = url.clone() {
                row = row.child(
                    CopyButton::new(
                        "chatgpt-sign-in-copy",
                        copy.sign_in_copy,
                        copy.sign_in_copied,
                    )
                    .text(url),
                );
            }
            let mut open = Button::new("chatgpt-sign-in-open")
                .size(Size::Sm)
                .icon_start(icon(Icon::Globe2, IconSize::Sm, Ds::get(cx)))
                .text(copy.sign_in_open);
            match url {
                Some(url) => open = open.on_click(move |_, _, cx| cx.open_url(&url)),
                None => open = open.disabled(),
            }
            return row.child(open).into_any_element();
        }
        if flags.failed() || flags.timed_out() {
            let restart = Button::new("chatgpt-sign-in-restart")
                .size(Size::Sm)
                .text(copy.sign_in_restart)
                .on_click(cx.listener(|this, _, _, cx| this.start("default", true, cx)));
            return row.child(restart).into_any_element();
        }
        if flags.signed || flags.again {
            let other = Button::new("chatgpt-sign-in-other")
                .size(Size::Sm)
                .variant(Variant::Inline)
                .text(copy.other_account)
                .on_click(cx.listener(|this, _, _, cx| this.start("new_account", false, cx)));
            row = row.child(other);
        }
        if flags.signed {
            if self.editing {
                let out = Button::new("chatgpt-sign-out")
                    .size(Size::Sm)
                    .variant(Variant::Outline)
                    .text(copy.sign_out)
                    .on_click(cx.listener(|_, _, _, cx| Self::sign_out(cx)));
                row = row.child(out);
            }
        } else {
            let (label, kind) = if flags.off {
                (copy.turn_on, "enable_plan")
            } else {
                (copy.plan_continue, "default")
            };
            let go = Button::new("chatgpt-sign-in-go")
                .size(Size::Sm)
                .text(label)
                .on_click(cx.listener(move |this, _, _, cx| this.start(kind, false, cx)));
            row = row.child(go);
        }
        row.into_any_element()
    }
}

impl Render for ChatGptCard {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let flags = self.flags();
        if self.editing && self.account.is_none() && self.phase == Phase::Idle {
            return Skeleton::new("chatgpt-sign-in-loading")
                .height(Height::Line)
                .width(Width::Full)
                .into_any_element();
        }
        let tone = if flags.failed() {
            NoticeTone::Error
        } else {
            NoticeTone::Neutral
        };
        let line: SharedString = self.line(&flags, copy).into();
        Notice::new(tone, line)
            .icon(Self::glyph(&flags, cx))
            .action(self.actions(&flags, copy, cx))
            .into_any_element()
    }
}
