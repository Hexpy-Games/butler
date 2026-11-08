//! The finish step (`FirstRunReady`, `chatgpt/ChatGptPlanUsage`): what was set up, then Start
//! chatting. The plan notice is acknowledged once, as soon as it shows and the AI is connected.
mod copy;

use butler_ds::ui::blocks::key_value_row::KeyValueRow;
use butler_ds::ui::blocks::setup_wizard_step_card::SetupWizardStepAction;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Lang;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, Context, IntoElement as _, ParentElement as _, Window};
use serde_json::{Value, json};

use super::card::step_card;
use super::copy::words as shared_words;
use super::providers::CardId;
use super::readiness::prep_status;
use super::{Mode, Onboarding};
use crate::ui::source::agent::Jobs;
use copy::{Words, words};

/// `ManageChatGptUsage`: the account's usage page, in the user's own browser.
const USAGE_URL: &str = "https://chatgpt.com/settings/usage";

/// `showPlanNotice` and whether its acknowledgement was sent.
#[derive(Default)]
struct PlanNotice {
    shown: bool,
    sent: bool,
}

pub(crate) fn screen(
    view: &Onboarding,
    window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let copy = words(view.lang);
    let Some((card, _)) = view.commit.read(cx).connected() else {
        return step_card(view, copy.finishing, [], cx)
            .content_key("finishing")
            .footer_start(prep_status(view, window, cx))
            .into_any_element();
    };
    let account = view.sign_in.read(cx).account().cloned();
    let show_notice = plan_notice(account.as_ref(), window, cx);
    let (saving, failed) = {
        let reply = view.reply.read(cx);
        (reply.saving(), reply.failed())
    };
    let mut forward = SetupWizardStepAction::new("first-run-finish", copy.finish)
        .forward()
        .on_click(cx.listener(|view, _, _, cx| {
            let lang = view.lang;
            let accepted_at = view.consent.read(cx).accepted_at();
            view.reply
                .update(cx, |reply, cx| reply.complete(lang, accepted_at, cx));
        }));
    if saving {
        forward = forward.disabled();
    }
    let mut body = Vec::new();
    if failed {
        let text = shared_words(view.lang).finish_failed;
        body.push(Typo::caption(text).tone(Tone::Danger).into_any_element());
    }
    body.push(rows(view, card, account.as_ref(), copy, cx));
    if show_notice {
        body.push(notice_row(copy, cx));
    }
    step_card(view, copy.done_title, body, cx)
        .content_key("ready")
        .description(copy.done_body)
        .on_back(
            shared_words(view.lang).back,
            cx.listener(|view, _, _, cx| view.back_from_ready(cx)),
        )
        .action(forward)
        .into_any_element()
}

/// The summary rows: the AI (with the ChatGPT account) and the reply language.
fn rows(
    view: &Onboarding,
    card: CardId,
    account: Option<&Value>,
    copy: &Words,
    cx: &App,
) -> AnyElement {
    let name = copy.providers[card as usize];
    let email = account
        .and_then(|account| account.get("label"))
        .and_then(Value::as_str)
        .filter(|label| label.contains('@'));
    let ai = match (card, email) {
        (CardId::Chatgpt, Some(email)) => format!("{name} · {email}"),
        _ => name.to_owned(),
    };
    // `SUPPORTED_UI_LANGUAGES` label of the saved reply language.
    let reply = match view.reply.read(cx).value() {
        Some(Lang::Ko) => "한국어",
        Some(Lang::En) => "English",
        None => "—",
    };
    // Rows only for what happened: a skipped or empty import has no row.
    let agents = view
        .imports
        .read(cx)
        .agent_counts()
        .filter(|(instructions, servers)| {
            view.mode == Mode::FirstRun && instructions + servers > 0
        });
    Stack::new()
        .gap(Space::Sm)
        .child(KeyValueRow::new(copy.rows[0], ai))
        .child(KeyValueRow::new(copy.rows[1], reply))
        .children(agents.map(|(instructions, servers)| {
            KeyValueRow::new(copy.rows[2], (copy.agent_counts)(instructions, servers))
        }))
        .into_any_element()
}

/// The plan notice line with Manage usage.
fn notice_row(copy: &Words, cx: &mut Context<Onboarding>) -> AnyElement {
    let manage = Button::new("first-run-manage-usage")
        .variant(Variant::Inline)
        .size(Size::Sm)
        .text(copy.manage_usage)
        .on_click(cx.listener(|_, _, _, cx| cx.open_url(USAGE_URL)));
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Sm)
        .wrap(true)
        .child(Typo::caption(copy.plan_notice).tone(Tone::Secondary))
        .child(manage)
        .into_any_element()
}

/// `showPlanNotice`: on once the account says the notice is pending, and it stays on. The first
/// frame it shows with the AI connected sends the acknowledgement.
fn plan_notice(account: Option<&Value>, window: &mut Window, cx: &mut App) -> bool {
    let pending = account
        .and_then(|account| account.get("plan_notice_pending"))
        .and_then(Value::as_bool)
        == Some(true);
    let state = window.use_keyed_state("first-run-plan-notice", cx, |_, _| PlanNotice::default());
    let (shown, send) = state.update(cx, |state, _| {
        state.shown |= pending;
        let send = state.shown && !state.sent;
        state.sent |= send;
        (state.shown, send)
    });
    if send {
        let job = Jobs::run(cx, |client| async move {
            client
                .acknowledge_chat_gpt_notice(&json!({ "kind": "plan" }))
                .await
                .ok()
        });
        cx.spawn(async move |_| {
            let _ = job.await;
        })
        .detach();
    }
    shown
}
