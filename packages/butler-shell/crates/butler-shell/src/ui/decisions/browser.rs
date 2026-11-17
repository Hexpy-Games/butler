//! ComposerBrowserHandoffSurface, `useBrowserDecisionMedia`, `browser/browserHandoff.ts` and
//! BrowserStepStill (in `browser/stills.rs`).
mod stills;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::composer_decision_panel::{Action, ComposerDecisionPanel, Detail};
use butler_ds::ui::blocks::composer_panel::Placement;
use butler_ds::ui::button::Variant;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, SharedString, Window};
use serde_json::{Value, json};

use super::DecisionCtx;
use crate::ui::browser::open_handoff;
use crate::ui::i18n::browser_handoff::BrowserHandoff;
use crate::ui::source::agent::Jobs;
use butler_shell_client::ShellClient;

pub(crate) use stills::browser_step_still;

/// `BrowserHandoffView`: a step only the user can do in a tab, not a permission.
struct HandoffView {
    title: String,
    details: Vec<String>,
    sign_in: bool,
}

/// `browserHandoffView`: the desktop app always has a browser, so the place is the tab.
fn handoff_view(request: &Value, lang: Lang, copy: &BrowserHandoff) -> Option<HandoffView> {
    let operation = request.pointer("/approval/operation")?;
    let field = |name: &str| operation.get(name).and_then(Value::as_str);
    let site = operation
        .get("targets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .find(|target| !target.is_empty());
    let step_line = |step: &str| match site {
        Some(site) => format!("{site} · {step}"),
        None => step.to_owned(),
    };
    let place = copy.in_tab.to_owned();
    match field("tool")? {
        "browser_sign_in_wait" => {
            let step =
                BrowserHandoff::sign_in_step(lang, field("sign_in_step").unwrap_or("unknown_form"));
            Some(HandoffView {
                title: copy.sign_in_title.to_owned(),
                details: vec![step_line(step), place],
                sign_in: true,
            })
        }
        "browser_pay_wait" => {
            let step =
                BrowserHandoff::pay_step(lang, field("wait_reason").unwrap_or("unknown_form"));
            Some(HandoffView {
                title: copy.pay_title.to_owned(),
                details: vec![step_line(step), place],
                sign_in: true,
            })
        }
        "browser_wait_for_user" => {
            let reason = field("wait_reason").unwrap_or("other");
            Some(HandoffView {
                title: BrowserHandoff::wait_handoff(lang, reason).to_owned(),
                details: site
                    .map(str::to_owned)
                    .into_iter()
                    .chain(std::iter::once(place))
                    .collect(),
                sign_in: matches!(reason, "sign_in" | "secure_field" | "secure_keypad"),
            })
        }
        _ => None,
    }
}

#[derive(Clone)]
enum Stop {
    Child {
        relation: String,
        parent: String,
    },
    Turn(Option<String>),
    /// A conversation that need not be open: the active turn its session view names.
    Session(String),
}

/// Stop ends the work that raised the request: a delegated task's waiting turn, or this conversation's own.
fn stop(target: Stop, cx: &mut App) {
    let copy = BrowserHandoff::get(cx);
    let failed = match &target {
        Stop::Child { .. } => copy.steward_stop_failed,
        Stop::Turn(None) => return,
        Stop::Turn(Some(_)) | Stop::Session(_) => copy.stop_failed,
    };
    let done = Jobs::run(cx, move |client| async move {
        match target {
            Stop::Child { relation, parent } => client
                .cancel_steward(&relation, &json!({"parent_session_id": parent}))
                .await
                .is_ok(),
            Stop::Turn(Some(turn)) => client.cancel_turn(&turn).await.is_ok(),
            Stop::Turn(None) => false,
            Stop::Session(session) => cancel_active(&client, &session).await,
        }
    });
    cx.spawn(async move |cx| {
        if !done.await.unwrap_or(false) {
            cx.update(|cx| toast::show(cx, Toast::error(failed)));
        }
    })
    .detach();
}

/// Electron `stopBrowserTurn`: cancels `session`'s active turn when it can be cancelled; with
/// none there is nothing to stop.
async fn cancel_active(client: &ShellClient, session: &str) -> bool {
    let Ok(view) = client.message_window(session, None, 1).await else {
        return false;
    };
    let turn = &view["active_turn"];
    match (turn["id"].as_str(), turn["cancellable"].as_bool()) {
        (Some(id), Some(true)) => client.cancel_turn(id).await.is_ok(),
        _ => true,
    }
}

/// Stop task on a conversation's browser tab.
pub(crate) fn stop_conversation(session: &str, cx: &mut App) {
    stop(Stop::Session(session.to_owned()), cx);
}

/// ComposerBrowserHandoffSurface; `None` when this session has nothing for it.
pub(crate) fn browser_surface(
    ctx: DecisionCtx<'_>,
    placement: Placement,
    _window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let requests = super::authority::valid_requests(ctx.view.authority_requests.as_deref()?);
    let request = *requests.first()?;
    let copy = BrowserHandoff::get(cx);
    let session = ctx.view.session_id.clone();
    let handoff = handoff_view(request, Ds::get(cx).lang(), copy)?;
    let turn = ctx.view.active_turn.as_ref().map(|turn| turn.id.clone());
    let target = request
        .get("source_session_id")
        .and_then(Value::as_str)
        .and_then(|source| {
            ctx.view
                .steward_children
                .iter()
                .flatten()
                .find(|child| child.session_id == source)
        })
        .map_or(Stop::Turn(turn), |child| Stop::Child {
            relation: child.relation.relation_id.clone(),
            parent: ctx.view.session_id.clone(),
        });
    let reference = request
        .get("request_ref")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut panel = ComposerDecisionPanel::new(
        SharedString::from(format!("browser-handoff-{reference}")),
        if handoff.sign_in {
            Icon::Key
        } else {
            Icon::Globe2
        },
        handoff.title,
        // Electron `onOpenSource` scrolls to the turn; the shell has no such action.
        |_, _, _| {},
    )
    .placement(placement)
    .eyebrow(copy.eyebrow)
    .details(handoff.details.into_iter().map(Detail::line))
    .action(
        Action::new(copy.stop, Variant::Secondary, move |_, cx| {
            stop(target.clone(), cx);
        })
        .icon(Icon::Square),
    );
    panel = panel.action(Action::new(
        copy.open_tab,
        Variant::Default,
        move |_, cx| open_handoff(&session, cx),
    ));
    if requests.len() > 1 {
        panel = panel.aside(Typo::caption(format!("+{}", requests.len() - 1)));
    }
    Some(panel.into_any_element())
}
