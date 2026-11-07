//! `PendingAskRows` and `usePendingAsks`: the requests of the open session that wait for an
//! answer. The reader of `pendingAsks.ts` is a keyed state here: the session's pending-asks
//! page is read again whenever the open session's event cursor moved.
use butler_ds::ui::Icon;
use butler_ds::ui::clickable::{Clickable, Variant as ClickVariant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_slot::{IconSlot, SlotSize, SlotTone};
use butler_ds::ui::layout::{Cross, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use chrono::{DateTime, Utc};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window, div};

use crate::ui::chat::AssistantHooks;
use crate::ui::i18n::Locale;
use crate::ui::i18n::session_sections::SessionSections;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{PendingAsk, PendingAskKind, SessionPendingAsks};

/// The reader's state: what it asked for last and the page that came back.
#[derive(Default)]
struct AsksState {
    requested: Option<(String, i64)>,
    page: Option<SessionPendingAsks>,
}

/// `usePendingAsks`: the open session's page; `None` until one arrives. An unavailable
/// projection never fabricates a section.
pub(super) fn pending_asks(
    session_id: &str,
    events: i64,
    window: &mut Window,
    cx: &mut App,
) -> Option<SessionPendingAsks> {
    let state = window.use_keyed_state("session-pending-asks", cx, |_, _| AsksState::default());
    let key = (session_id.to_owned(), events);
    if state.read(cx).requested.as_ref() != Some(&key) {
        state.update(cx, |state, _| state.requested = Some(key.clone()));
        let id = session_id.to_owned();
        let done = Jobs::run(cx, move |client| async move {
            let value = client.get_session_pending_asks(&id).await.ok()?;
            serde_json::from_value::<SessionPendingAsks>(value).ok()
        });
        let state = state.clone();
        cx.spawn(async move |cx| {
            let Some(page) = done.await.flatten() else {
                return;
            };
            state.update(cx, |state, cx| {
                if state.requested.as_ref() == Some(&key) {
                    state.page = Some(page);
                    cx.notify();
                }
            });
        })
        .detach();
    }
    state
        .read(cx)
        .page
        .clone()
        .filter(|page| page.session_id == session_id)
}

/// `PendingAskRows`
pub(super) fn pending_ask_rows(asks: &[PendingAsk], cx: &mut App) -> Vec<AnyElement> {
    asks.iter().map(|ask| ask_row(ask, cx)).collect()
}

fn ask_row(ask: &PendingAsk, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let glyph = match ask.kind {
        PendingAskKind::Approval => Icon::ShieldQuestion,
        PendingAskKind::CanonProposal => Icon::Notebook,
        _ => Icon::MessageSquare,
    };
    let meta = ask_meta(ask, ds.lang(), SessionSections::get(cx));
    let row = Stack::row()
        .cross(Cross::Start)
        .gap(Space::Sm)
        .child(
            IconSlot::new()
                .size(SlotSize::Sm)
                .min_line()
                .tone(SlotTone::Secondary)
                .child(icon(glyph, IconSize::Sm, ds)),
        )
        .child(
            Stack::new()
                .gap(Space::Xs)
                .min_width(MinWidth::Zero)
                .child(Typo::body(ask.title.clone()).wrap(Wrap::Anywhere))
                .children(
                    ask.target_label
                        .clone()
                        .map(|label| Typo::caption(label).tone(Tone::Secondary)),
                )
                .child(Typo::caption(meta).tone(Tone::Secondary)),
        );
    let Some(message) = ask.source_message_id.clone() else {
        return div().child(row).into_any_element();
    };
    let source = ask.source_session_id.clone();
    Clickable::new(SharedString::from(format!("pending-ask-{}", ask.ask_id)))
        .variant(ClickVariant::Text)
        .stretch()
        .on_click(move |_, _, cx| open_ask_source(&source, &message, cx))
        .child(row)
        .into_any_element()
}

/// `askMeta`
fn ask_meta(ask: &PendingAsk, lang: Lang, copy: &SessionSections) -> String {
    let kind = match ask.kind {
        PendingAskKind::Approval => copy.approval,
        PendingAskKind::CanonProposal => copy.epic,
        _ => copy.question,
    };
    [
        Some(kind.to_owned()),
        relative_age(&ask.waiting_since, lang),
        ask.deferred.then(|| copy.deferred.to_owned()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ")
}

/// `relativeAge` of a timestamp; `None` when it does not parse.
fn relative_age(since: &str, lang: Lang) -> Option<String> {
    let at = DateTime::parse_from_rfc3339(since).ok()?;
    let seconds = (Utc::now() - at.with_timezone(&Utc)).num_seconds().max(0);
    let locale = match lang {
        Lang::Ko => Locale::Ko,
        Lang::En => Locale::En,
    };
    Some(locale.strings().relative_age(seconds))
}

/// `openAskSource`: opens the session the ask came from. Scrolling to its message
/// (`useMessageNavigation`) has no route from the inspector.
fn open_ask_source(session_id: &str, _message_id: &str, cx: &mut App) {
    let open = cx
        .try_global::<AssistantHooks>()
        .and_then(|hooks| hooks.open_session.clone());
    if let Some(open) = open {
        open(session_id, cx);
    }
}
