//! ChatGPT sign-in (`FirstRunSignIn`, `useSignIn`, `chatgpt/*`): the controller of the browser
//! sign-in. Starting it opens the system browser at the agent flow's `auth_url`; the controller
//! then polls the flow once a second until the browser finishes, with Cancel and Copy link as the
//! ways out. The screen is in [`view`].
//! React also re-reads the account on window focus and on `setup.chatgpt_account_changed`; here
//! it reads on open and after the sign-in's own results.
mod copy;
mod view;

use std::time::{Duration, Instant};

use butler_shell_client::Error;
use gpui::{Context, EventEmitter};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::ui::settings::state::{fetch, fetch_if};

pub(crate) use view::screen;

const POLL: Duration = Duration::from_secs(1); // useSignIn.ts SIGN_IN_POLL_MS
const TIMEOUT: Duration = Duration::from_mins(5); // useSignIn.ts SIGN_IN_TIMEOUT_MS

/// The browser sign-in finished.
pub(crate) enum SignInEvent {
    SignedIn,
}

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

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Starting => "starting",
            Self::Waiting => "waiting",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timedout",
            Self::Failed => "failed",
        }
    }
}

/// `OpenAIOAuthLoginResult`, merged over the flow's earlier answers. The `auth_url` carries the
/// OAuth state: no `Debug`, and it is dropped once the flow ends.
#[derive(Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct Flow {
    #[serde(rename = "flow_id")]
    id: Option<String>,
    auth_url: Option<String>,
    error: Option<String>,
    label: Option<String>,
    plan_enabled: Option<bool>,
    status: String,
}

impl Flow {
    fn merge(&mut self, next: Self) {
        self.id = next.id.or(self.id.take());
        self.auth_url = next.auth_url.or(self.auth_url.take());
        self.error = next.error.or(self.error.take());
        self.label = next.label.or(self.label.take());
        self.plan_enabled = next.plan_enabled.or(self.plan_enabled);
        if !next.status.is_empty() {
            self.status = next.status;
        }
    }

    /// `SIGNED_IN`
    fn signed_in(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "profile_exists")
    }
}

pub(crate) struct SignIn {
    /// `useChatGptAccount`
    account: Option<Value>,
    phase: Phase,
    flow: Option<Flow>,
    /// `run`: a newer start or cancel makes older answers stale.
    run: u64,
    /// The `auth_url` already opened in the browser.
    opened: Option<String>,
}

impl EventEmitter<SignInEvent> for SignIn {}

impl SignIn {
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        Self::refresh_account(cx);
        Self {
            account: None,
            phase: Phase::Idle,
            flow: None,
            run: 0,
            opened: None,
        }
    }

    /// The ChatGPT account (`useChatGptAccount`).
    pub(crate) fn account(&self) -> Option<&Value> {
        self.account.as_ref()
    }

    /// Leaving the screen cancels a running sign-in.
    pub(crate) fn leave(&mut self, cx: &mut Context<Self>) {
        if matches!(self.phase, Phase::Waiting | Phase::Starting) {
            self.cancel(Phase::Cancelled, cx);
        }
        self.run += 1;
        self.phase = Phase::Idle;
        cx.notify();
    }

    fn account_text(&self, key: &str) -> Option<&str> {
        self.account.as_ref()?.get(key)?.as_str()
    }

    fn account_status(&self) -> &str {
        self.account_text("status").unwrap_or_default()
    }

    fn refresh_account(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.get_chat_gpt_account().await },
            |this: &mut Self, result: Result<Value, Error>, _| {
                if let Ok(account) = result {
                    this.account = Some(account);
                }
            },
        );
    }

    /// `startSignIn`: opens the browser at the flow's URL once it answers.
    fn start(&mut self, kind: &'static str, force: bool, cx: &mut Context<Self>) {
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
            move |this: &mut Self, result: Result<Flow, Error>, cx| match result {
                Ok(flow) => this.settle(id, flow, cx),
                Err(_) if id == this.run => this.phase = Phase::Failed,
                Err(_) => {}
            },
        );
    }

    /// `settle`: merge an answer of the flow and move the phase.
    fn settle(&mut self, id: u64, result: Flow, cx: &mut Context<Self>) {
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
                self.forget_url();
                Self::refresh_account(cx);
                cx.emit(SignInEvent::SignedIn);
            }
            "cancelled" | "failed" => {
                self.phase = match error.as_deref() {
                    Some("oauth_timeout") => Phase::TimedOut,
                    Some("oauth_denied") => Phase::Idle,
                    _ if status == "cancelled" => Phase::Cancelled,
                    _ => Phase::Failed,
                };
                self.forget_url();
            }
            "starting" | "pending" if self.phase != Phase::Waiting => {
                self.phase = Phase::Waiting;
                Self::schedule_poll(id, Instant::now(), cx);
            }
            _ => {}
        }
    }

    fn forget_url(&mut self) {
        self.opened = None;
        if let Some(flow) = self.flow.as_mut() {
            flow.auth_url = None;
        }
    }

    fn schedule_poll(id: u64, started: Instant, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(POLL).await;
            let _ = this.update(cx, |this, cx| this.poll(id, started, cx));
        })
        .detach();
    }

    /// `useSignInPolling`: one read per second while waiting, until the timeout. The screen
    /// re-renders only when the answer changed something.
    fn poll(&mut self, id: u64, started: Instant, cx: &mut Context<Self>) {
        if id != self.run || self.phase != Phase::Waiting {
            return;
        }
        if started.elapsed() > TIMEOUT {
            self.cancel(Phase::TimedOut, cx);
            return;
        }
        let Some(flow_id) = self.flow.as_ref().and_then(|flow| flow.id.clone()) else {
            return;
        };
        fetch_if(
            cx,
            move |client| async move { client.get_setup_oauth_flow(&flow_id).await },
            move |this: &mut Self, result: Result<Flow, Error>, cx| {
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
        self.forget_url();
        cx.notify();
        let Some(flow_id) = self.flow.as_ref().and_then(|flow| flow.id.clone()) else {
            return;
        };
        fetch(
            cx,
            move |client| async move { client.cancel_setup_oauth(&flow_id).await },
            move |this: &mut Self, result: Result<Flow, Error>, cx| {
                if this.run == id
                    && let Ok(flow) = result
                    && flow.signed_in()
                {
                    this.flow.get_or_insert_with(Flow::default).merge(flow);
                    this.phase = Phase::Idle;
                    Self::refresh_account(cx);
                    cx.emit(SignInEvent::SignedIn);
                }
            },
        );
    }
}
