//! ComposerBrowserHandoffSurface, `useBrowserDecisionMedia`, `browser/browserHandoff.ts` and
//! BrowserStepStill (in `browser/stills.rs`).
mod stills;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::composer_decision_panel::{Action, ComposerDecisionPanel, Detail};
use butler_ds::ui::button::Variant;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, SharedString, Window};
use serde_json::Value;

use super::DecisionCtx;
use crate::ui::i18n::browser_handoff::BrowserHandoff;
use crate::ui::source::agent::Jobs;

pub(crate) use stills::browser_step_still;

/// `BrowserHandoffView`: a step only the user can do in a tab, not a permission.
struct HandoffView {
    title: String,
    details: Vec<String>,
    sign_in: bool,
}

/// `browserHandoffView`. The shell has no browser tab to open, so the place is always the
/// desktop line (`canOpenTab` is false).
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
    let place = copy.on_desktop.to_owned();
    match field("tool")? {
        "browser_sign_in_wait" => {
            let step = BrowserHandoff::sign_in_step(lang, field("sign_in_step").unwrap_or("unknown_form"));
            Some(HandoffView {
                title: copy.sign_in_title.to_owned(),
                details: vec![step_line(step), place],
                sign_in: true,
            })
        }
        "browser_pay_wait" => {
            let step = BrowserHandoff::pay_step(lang, field("wait_reason").unwrap_or("unknown_form"));
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

/// `handoff.onStop` (`cancelActiveTurn`): cancels the session's running turn.
fn stop(turn: Option<String>, cx: &mut App) {
    let Some(turn) = turn else {
        return;
    };
    let failed = BrowserHandoff::get(cx).stop_failed;
    let done = Jobs::run(cx, move |client| async move {
        client.cancel_turn(&turn).await.is_ok()
    });
    cx.spawn(async move |cx| {
        if !done.await.unwrap_or(false) {
            cx.update(|cx| toast::show(cx, Toast::error(failed)));
        }
    })
    .detach();
}

/// ComposerBrowserHandoffSurface; `None` when this session has nothing for it.
pub(crate) fn browser_surface(
    ctx: DecisionCtx<'_>,
    _window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let requests = ctx.view.authority_requests.as_deref()?;
    let request = requests.first()?;
    let copy = BrowserHandoff::get(cx);
    let handoff = handoff_view(request, Ds::get(cx).lang(), copy)?;
    let turn = ctx.view.active_turn.as_ref().map(|turn| turn.id.clone());
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
        |_, _, _| {},
    )
    .eyebrow(copy.eyebrow)
    .details(handoff.details.into_iter().map(Detail::line))
    .action(
        Action::new(copy.stop, Variant::Secondary, move |_, cx| {
            stop(turn.clone(), cx);
        })
        .icon(Icon::Square),
    );
    if requests.len() > 1 {
        panel = panel.aside(Typo::caption(format!("+{}", requests.len() - 1)));
    }
    Some(panel.into_any_element())
}
