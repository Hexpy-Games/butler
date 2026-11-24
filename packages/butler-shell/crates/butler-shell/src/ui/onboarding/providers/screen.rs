//! The list screen (`FirstRunProviderList`, `firstRunCardView`, `CardGlyph`): the well-known
//! services on top, the rest behind "more".
use std::rc::Rc;

use butler_ds::ui::blocks::choice_card::{
    self, ChoiceCard, ChoiceCardList, ChoiceState, ChoiceTile, ChoiceTileGrid,
};
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::provider_logo::{ProviderLogo, ProviderLogoSize, provider_logo_name};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::tag::{Tag, Tone as TagTone};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, Context, IntoElement as _, ParentElement as _, SharedString, Styled as _, Window,
};

use super::copy::{Words, description, more_providers, words};
use super::{CardId, CardKind, ProviderEntry, card_name};
use crate::ui::Icon;
use crate::ui::onboarding::Onboarding;
use crate::ui::onboarding::card::step_card;
use crate::ui::onboarding::copy::words as shared_words;
use crate::ui::onboarding::readiness::ReadinessStatus;

/// `providerCardLayout`: Other joins the top cards when a local server answers, so its models
/// stay one click away.
fn layout(local_reachable: bool, hosted: &[ProviderEntry]) -> (Vec<CardId>, Vec<CardId>) {
    let mut top = super::top_cards();
    let mut more: Vec<CardId> = hosted
        .iter()
        .map(|entry| CardId::Key(entry.id.clone()))
        .filter(|card| !top.contains(card))
        .collect();
    if local_reachable {
        top.push(CardId::Other);
    } else {
        more.push(CardId::Other);
    }
    (top, more)
}

/// What the cards read from the local servers, taken before the cards borrow `cx`.
struct Snapshot {
    online: bool,
    hosted: Rc<[ProviderEntry]>,
    lang: Lang,
    found: Option<SharedString>,
    top: Vec<CardId>,
    more: Vec<CardId>,
}

/// `providerCardView`: offline, only Other can be picked (it holds the models on this computer).
fn card_view(
    id: &CardId,
    tile: bool,
    snap: &Snapshot,
    copy: &Words,
) -> (ChoiceState, SharedString) {
    let description = description(snap.lang, id);
    if id.kind() == CardKind::Custom {
        return (
            ChoiceState::Default,
            snap.found.clone().unwrap_or_else(|| description.into()),
        );
    }
    if snap.online {
        (ChoiceState::Default, description.into())
    } else if tile {
        (ChoiceState::Disabled, copy.offline_tile.into())
    } else {
        (ChoiceState::Disabled, copy.offline_short.into())
    }
}

/// `CardGlyph`: the brand logo, or the neutral server icon (Other), at the card's glyph size: the
/// card and the tile size whatever glyph they hold to `--choice-card-glyph-size`.
/// // DS: ChoiceCard.module.css:135-149, 238-241
fn glyph(id: &CardId, cx: &Context<Onboarding>) -> AnyElement {
    match provider_logo_name(id.provider_id(), None, false) {
        Some(name) => ProviderLogo::new(name)
            .size(if Ds::get(cx).compact() {
                ProviderLogoSize::Md
            } else {
                ProviderLogoSize::Sm
            })
            .into_any_element(),
        None => choice_card::glyph(Icon::Server, cx).into_any_element(),
    }
}

fn top_card(
    id: &CardId,
    current: bool,
    snap: &Snapshot,
    copy: &Words,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let (state, description) = card_view(id, false, snap, copy);
    let name = SharedString::from(format!("first-run-card-{}", id.slug()));
    let pick = id.clone();
    let mut row = ChoiceCard::new(
        name.clone(),
        glyph(id, cx),
        card_name(id, snap.lang, &snap.hosted),
    )
    .description(description)
    .state(state)
    .selected(current)
    .on_click(cx.listener(move |view, _, window, cx| view.pick(pick.clone(), window, cx)));
    if current {
        let tag = SharedString::from(format!("first-run-tag-{}", id.slug()));
        row = row.tag(Tag::new(tag, copy.current).tone(TagTone::Accent));
    }
    crate::ui::widgets::control_anchor(
        gpui::div().flex().flex_col(),
        &name,
        state != ChoiceState::Disabled,
    )
    .child(key_anchor(id, row.into_any_element()))
    .into_any_element()
}

fn more_tile(
    id: &CardId,
    current: bool,
    snap: &Snapshot,
    copy: &Words,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let (state, description) = card_view(id, true, snap, copy);
    let name = SharedString::from(format!("first-run-tile-{}", id.slug()));
    let pick = id.clone();
    let tile = ChoiceTile::new(name, glyph(id, cx), card_name(id, snap.lang, &snap.hosted))
        .description(description)
        .state(state)
        .selected(current)
        .on_click(cx.listener(move |view, _, window, cx| view.pick(pick.clone(), window, cx)));
    key_anchor(id, tile.into_any_element())
}

/// Every API key card is also named by its provider, so the harness can match the list against the catalog.
fn key_anchor(id: &CardId, el: AnyElement) -> AnyElement {
    match id {
        CardId::Key(p) => crate::ui::widgets::anchored(el, &format!("first-run-key-card-{p}")),
        _ => el,
    }
}

/// Butler is still preparing: the pick is kept and connects once it is ready.
fn preparing(text: &'static str) -> AnyElement {
    Stack::row()
        .gap(Space::Sm)
        .cross(Cross::Center)
        .child(crate::ui::widgets::anchored(
            Spinner::new("first-run-prep-spinner").size(14.),
            "first-run-prep-spinner",
        ))
        .child(Typo::caption(text).tone(Tone::Secondary))
        .into_any_element()
}

fn snapshot(view: &Onboarding, lang: Lang, cx: &Context<Onboarding>) -> Snapshot {
    let local = view.providers.read(cx);
    let hosted = local.hosted();
    let (top, more) = layout(local.reachable(), &hosted);
    Snapshot {
        online: local.online(),
        hosted,
        lang,
        found: local.found(lang),
        top,
        more,
    }
}

pub(crate) fn screen(
    view: &Onboarding,
    window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let lang = view.lang;
    let (copy, shared) = (words(lang), shared_words(lang));
    let snap = snapshot(view, lang, cx);
    let current = view.current_card_id(cx);
    // Run setup again opens "more" when the AI in use is there.
    let more_open = window.use_keyed_state("first-run-more-open", cx, |_, _| None::<bool>);
    let expanded = more_open
        .read(cx)
        .unwrap_or_else(|| current.as_ref().is_some_and(|id| snap.more.contains(id)));

    let mut body = Vec::new();
    if !snap.online {
        body.push(
            Notice::new(NoticeTone::Warning, copy.offline)
                .icon(icon(Icon::Globe2, IconSize::Md, Ds::get(cx)))
                .into_any_element(),
        );
    }
    if view.readiness.read(cx).view().status == ReadinessStatus::Preparing {
        body.push(preparing(copy.prep_wait));
    }
    let cards = snap
        .top
        .iter()
        .map(|id| top_card(id, current.as_ref() == Some(id), &snap, copy, cx))
        .collect::<Vec<_>>();
    body.push(ChoiceCardList::new().children(cards).into_any_element());
    // The tiles' column is in the body also while "more" is closed (empty, it still takes a
    // gap). // FirstRunProviderList.tsx:51-55
    let mut more = Stack::new().cross(Cross::Start).gap(Space::Sm);
    if expanded {
        let tiles = snap
            .more
            .iter()
            .map(|id| more_tile(id, current.as_ref() == Some(id), &snap, copy, cx))
            .collect::<Vec<_>>();
        more = more.child(ChoiceTileGrid::new("first-run-more-providers").children(tiles));
    }
    body.push(more.into_any_element());

    let label = if expanded {
        copy.show_less.to_owned()
    } else {
        more_providers(lang, snap.more.len())
    };
    let chevron = if expanded {
        Icon::ChevronUpIcon
    } else {
        Icon::ChevronDown
    };
    let toggle = Button::new("first-run-more-toggle")
        .variant(Variant::Inline)
        .size(Size::Sm)
        .text(label)
        .icon_end(icon(chevron, IconSize::Sm, Ds::get(cx)))
        .on_click(move |_, _, cx| {
            more_open.update(cx, |open, cx| {
                *open = Some(!expanded);
                cx.notify();
            });
        });
    step_card(view, "providers", copy.title, body, cx)
        .description(copy.lede)
        .on_back(
            shared.back,
            cx.listener(|view, _, _, cx| view.back_from_connect(cx)),
        )
        .footer_start(
            Stack::new()
                .cross(Cross::Start)
                .child(crate::ui::widgets::anchored(toggle, "first-run-more-toggle")),
        )
        .into_any_element()
}
