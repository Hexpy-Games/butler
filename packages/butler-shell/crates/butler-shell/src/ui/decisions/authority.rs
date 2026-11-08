//! ComposerAuthorityDecisionSurface, `useComposerAuthorityDecision` and
//! ComposerDecisionAttachment: the authority card in the composer slot, and the pill that
//! reopens it while the owner composes a message instead.
mod mask;
mod request;
mod schedule;
mod visible;

use std::collections::HashSet;
use std::rc::Rc;

use butler_ds::tokens::Length;
use butler_ds::ui::blocks::composer_decision_panel::{ComposerDecisionPanel, Detail};
use butler_ds::ui::blocks::composer_panel::Placement;
use butler_ds::ui::blocks::split_button::{SplitButton, SplitItem, SplitSize};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::overlay::place::Side;
use butler_ds::ui::tag::{Tag, Tone as TagTone};
use butler_ds::ui::typo::Typo;
use butler_shell_client::{AuthorityDecision, ShellClient};
use gpui::{
    AnyElement, App, Entity, Global, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, Styled as _, Window, div,
};
use serde_json::Value;

use super::DecisionCtx;
use super::canon::ApprovalLineText;
use crate::ui::i18n::authority::Authority;
use crate::ui::source::Risk;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{AuthorityDecisionTransportView, SessionView};
use request::{AllowSite, Line};
use visible::{approval_line, visible_code};

/// Registered once by the shell: refreshes the session view after a decision was accepted. The
/// handler gets the session id.
type ChangedHandler = Rc<dyn Fn(&str, &mut App)>;

#[derive(Default)]
struct AuthorityChanged(Option<ChangedHandler>);

impl Global for AuthorityChanged {}

pub(crate) fn on_authority_changed(cx: &mut App, handler: impl Fn(&str, &mut App) + 'static) {
    cx.default_global::<AuthorityChanged>().0 = Some(Rc::new(handler));
}

fn authority_changed(session: &str, cx: &mut App) {
    if let Some(handler) = cx
        .try_global::<AuthorityChanged>()
        .and_then(|g| g.0.clone())
    {
        handler(session, cx);
    }
}

/// `InitiatedApprovalLine`'s text: the label and masked target of an initiated approval; `None`
/// when `origin.approval` does not normalize.
pub(crate) fn initiated_approval(raw: &Value, cx: &App) -> Option<ApprovalLineText> {
    let (label, target) = request::action_view(raw, Authority::get(cx))?;
    Some(ApprovalLineText {
        label,
        target: mask::mask_action_secrets(&target),
    })
}

/// What a button decides.
pub(super) enum Verdict {
    Allow(&'static str),
    Deny,
}

/// The hook's own state (`pending`, `failed`) and what a decision needs.
#[derive(Clone)]
pub(super) struct Handles {
    session: String,
    request_ref: String,
    key: String,
    pending: Entity<HashSet<String>>,
    failed: Entity<Option<String>>,
}

async fn send(client: ShellClient, session: String, request_ref: String, verdict: Verdict) -> bool {
    let (decision, expected) = match verdict {
        Verdict::Allow(scope) => (
            AuthorityDecision::Allow {
                scope: scope.into(),
            },
            "allowed",
        ),
        Verdict::Deny => (AuthorityDecision::Deny, "denied"),
    };
    let Ok(raw) = client
        .answer_authority(&session, &request_ref, decision)
        .await
    else {
        return false;
    };
    // `isAcceptedAuthorityDecisionResponse`
    serde_json::from_value::<AuthorityDecisionTransportView>(raw).is_ok_and(|view| {
        view.request_ref.as_ref().and_then(Value::as_str) == Some(request_ref.as_str())
            && view.decision.as_ref().and_then(Value::as_str) == Some(expected)
            && view.scheduled.as_ref().is_some_and(Value::is_boolean)
    })
}

impl Handles {
    /// `decide`: one in-flight decision per request.
    /// Returns false when the request already has one in flight.
    pub(super) fn decide(&self, verdict: Verdict, cx: &mut App) -> bool {
        let key = self.key.clone();
        let fresh = self.pending.update(cx, |pending, cx| {
            cx.notify();
            pending.insert(key)
        });
        if !fresh {
            return false;
        }
        self.failed.update(cx, |failed, cx| {
            *failed = None;
            cx.notify();
        });
        let (session, request_ref) = (self.session.clone(), self.request_ref.clone());
        let done = Jobs::run(cx, move |client| {
            send(client, session, request_ref, verdict)
        });
        let this = self.clone();
        cx.spawn(async move |cx| {
            let applied = done.await.unwrap_or(false);
            this.pending.update(cx, |pending, cx| {
                pending.remove(&this.key);
                cx.notify();
            });
            if applied {
                cx.update(|cx| authority_changed(&this.session, cx));
            } else {
                this.failed.update(cx, |failed, cx| {
                    *failed = Some(this.key.clone());
                    cx.notify();
                });
            }
        })
        .detach();
        true
    }
}

/// `ComposerAuthorityDecision`.
struct Decision {
    handles: Handles,
    view: request::View,
    copy: Authority,
    /// The legacy `scope` the conversation grant needs, unless the operation refuses it.
    has_scope: bool,
    allow_site: Option<AllowSite>,
    progress: Progress,
    pending_count: usize,
}

struct Progress {
    pending: bool,
    failed: bool,
}

fn view_is_handoff(view: &SessionView) -> bool {
    view.authority_requests.as_deref().is_some_and(|requests| {
        request::cards(requests)
            .first()
            .is_some_and(request::is_handoff)
    })
}

/// The requests the card accepts (`normalizeAuthorityApprovals`), as the wire records.
pub(super) fn valid_requests(raw: &[Value]) -> Vec<&Value> {
    request::valid(raw)
}

fn state<T: 'static>(
    name: &str,
    session: &str,
    init: T,
    window: &mut Window,
    cx: &mut App,
) -> Entity<T> {
    window.use_keyed_state(
        SharedString::from(format!("{name}-{session}")),
        cx,
        move |_, _| init,
    )
}

fn decision(view: &SessionView, window: &mut Window, cx: &mut App) -> Option<Decision> {
    let cards = request::cards(view.authority_requests.as_deref()?);
    let card = cards.first()?;
    let session = view.session_id.clone();
    let key = format!("{session}:{}", card.request_ref);
    let pending = state("authority-pending", &session, HashSet::new(), window, cx);
    let failed = state("authority-failed", &session, None::<String>, window, cx);
    let copy = Authority::get(cx);
    let operation = card.approval.as_ref().and_then(|a| a.operation.as_ref());
    Some(Decision {
        view: request::view(card, copy),
        copy,
        has_scope: card.scope.is_some()
            && operation.is_none_or(|o| o.allow_conversation != Some(false)),
        allow_site: operation.and_then(|o| o.allow_site),
        progress: Progress {
            pending: pending.read(cx).contains(&key),
            failed: failed.read(cx).as_deref() == Some(key.as_str()),
        },
        pending_count: cards.len(),
        handles: Handles {
            session,
            request_ref: card.request_ref.clone(),
            key,
            pending,
            failed,
        },
    })
}

/// ComposerAuthorityDecisionSurface; `None` when this session has nothing for it.
pub(crate) fn authority_surface(
    ctx: DecisionCtx<'_>,
    placement: Placement,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    // The routing asks the browser handoff panel first.
    if view_is_handoff(ctx.view) {
        return None;
    }
    let decision = decision(ctx.view, window, cx)?;
    Some(surface(&decision, placement, cx))
}

/// An authority request or browser handoff waits (what the two surfaces return `None` without).
pub(super) fn has_request(view: &SessionView) -> bool {
    view.authority_requests.as_deref().is_some_and(|requests| {
        !request::cards(requests).is_empty() || !request::valid(requests).is_empty()
    })
}

/// A control the live harness drives by id.
fn handle(id: &'static str, control: impl gpui::IntoElement) -> AnyElement {
    crate::ui::widgets::anchor(div().id(id), id)
        .child(control)
        .into_any_element()
}

fn aside(d: &Decision, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let tone = match d.view.risk {
        Risk::Low => TagTone::Neutral,
        Risk::Medium => TagTone::Warning,
        Risk::High => TagTone::Danger,
    };
    div()
        .flex()
        .items_center()
        .gap(ds.len(Length::SpaceSm))
        .child(Tag::new("authority-risk", d.copy.risk(d.view.risk)).tone(tone))
        .children((d.pending_count > 1).then(|| Typo::caption(format!("+{}", d.pending_count - 1))))
        .into_any_element()
}

/// The split button: allow once (or in this chat) and the wider scope in its menu.
fn allow(d: &Decision) -> SplitButton {
    let copy = d.copy;
    let once = d.handles.clone();
    let text = if d.allow_site.is_some() {
        copy.allow_in_chat()
    } else {
        copy.allow_once()
    };
    let mut split = SplitButton::new("authority-allow-once", text, move |_, _, cx| {
        once.decide(Verdict::Allow("once"), cx);
    })
    .size(SplitSize::Sm)
    .menu_side(Side::Top);
    if d.progress.pending {
        split = split.disabled();
    }
    let handles = d.handles.clone();
    match d.allow_site {
        Some(site) => {
            let label = if site == AllowSite::Payment {
                copy.allow_payment_site()
            } else {
                copy.allow_site()
            };
            let mut item = SplitItem::new(label, move |_, cx| {
                handles.decide(Verdict::Allow("site"), cx);
            });
            if site == AllowSite::SignedIn {
                item = item.description([SharedString::from(copy.allow_site_description())]);
            }
            split.item(item)
        }
        None => {
            let lines = d
                .view
                .conversation_scope
                .iter()
                .map(|scope| SharedString::from(scope.clone()))
                .chain([SharedString::from(copy.allow_description())]);
            let mut item = SplitItem::new(copy.allow_conversation(), move |_, cx| {
                handles.decide(Verdict::Allow("conversation"), cx);
            })
            .description(lines);
            if !d.has_scope {
                item = item.disabled();
            }
            split.item(item)
        }
    }
}

fn surface(d: &Decision, placement: Placement, cx: &mut App) -> AnyElement {
    let copy = d.copy;
    let details = d.view.details.iter().map(|line| match line {
        Line::Text(text) => Detail::line(approval_line(text)),
        Line::Code(code) => Detail::code(visible_code(code)),
    });
    // No clamp: a long card scrolls in its details area, so Allow never sits over hidden text.
    let mut panel = ComposerDecisionPanel::new(
        "authority-decision",
        d.view.action_kind.icon(),
        approval_line(&d.view.title),
        |_, _, _| {},
    )
    .eyebrow(copy.permission())
    .placement(placement)
    .literal()
    .details(details)
    .aside(aside(d, cx));
    if d.progress.failed {
        panel = panel.error(copy.decision_failed());
    }
    let handles = d.handles.clone();
    let mut deny = Button::new("authority-deny-button")
        .variant(Variant::Secondary)
        .size(Size::Sm)
        .text(copy.deny())
        .on_click(move |_, _, cx| {
            handles.decide(Verdict::Deny, cx);
        });
    if d.progress.pending {
        deny = deny.disabled();
    }
    panel = panel
        .custom_action(handle("authority-deny", deny))
        .custom_action(handle("authority-allow-always", allow(d)));
    crate::ui::widgets::anchor(div().id("approval-card"), "approval-card")
        .child(panel)
        .into_any_element()
}
