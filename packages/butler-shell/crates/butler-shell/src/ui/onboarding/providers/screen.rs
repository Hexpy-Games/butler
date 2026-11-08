//! The list screen (`FirstRunProviderList`, `firstRunCardView`, `CardGlyph`): the well-known
//! services on top, the rest behind "more".
use butler_ds::ui::blocks::choice_card::{
    ChoiceCard, ChoiceCardList, ChoiceState, ChoiceTile, ChoiceTileGrid,
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
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, SharedString, Window};

use super::copy::{Words, more_providers, words};
use super::{CardId, CardKind, card};
use crate::ui::Icon;
use crate::ui::onboarding::Onboarding;
use crate::ui::onboarding::card::step_card;
use crate::ui::onboarding::copy::words as shared_words;
use crate::ui::onboarding::readiness::ReadinessStatus;

const TOP: [CardId; 3] = [CardId::Chatgpt, CardId::Claude, CardId::Gemini];
const MORE: [CardId; 8] = [
    CardId::Openai,
    CardId::Grok,
    CardId::Qwen,
    CardId::Kimi,
    CardId::ZaiCoding,
    CardId::ZaiApi,
    CardId::OpencodeGo,
    CardId::Other,
];

/// `providerCardLayout`: Other joins the top cards when a local server answers, so its models
/// stay one click away.
fn layout(local_reachable: bool) -> (Vec<CardId>, Vec<CardId>) {
    let mut top = TOP.to_vec();
    let mut more = MORE.to_vec();
    if local_reachable {
        more.retain(|id| *id != CardId::Other);
        top.push(CardId::Other);
    }
    (top, more)
}

/// What the cards read from the local servers, taken before the cards borrow `cx`.
struct Snapshot {
    online: bool,
    found: Option<SharedString>,
    more_open: Option<bool>,
    top: Vec<CardId>,
    more: Vec<CardId>,
}

/// `providerCardView`: offline, only Other can be picked (it holds the models on this computer).
fn card_view(id: CardId, tile: bool, snap: &Snapshot, copy: &Words) -> (ChoiceState, SharedString) {
    let description = copy.descriptions[id as usize];
    if card(id).kind == CardKind::Custom {
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

/// `CardGlyph`: the brand logo, or the neutral server icon (Other).
fn glyph(
    id: CardId,
    size: ProviderLogoSize,
    icon_size: IconSize,
    cx: &Context<Onboarding>,
) -> AnyElement {
    match provider_logo_name(card(id).provider_id.unwrap_or_default(), None, false) {
        Some(name) => ProviderLogo::new(name).size(size).into_any_element(),
        None => icon(Icon::Server, icon_size, Ds::get(cx)).into_any_element(),
    }
}

fn top_card(
    id: CardId,
    current: bool,
    snap: &Snapshot,
    copy: &Words,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let (state, description) = card_view(id, false, snap, copy);
    let index = id as usize;
    let mut row = ChoiceCard::new(
        ("first-run-card", index),
        glyph(id, ProviderLogoSize::Lg, IconSize::Lg, cx),
        copy.names[index],
    )
    .description(description)
    .state(state)
    .selected(current)
    .on_click(cx.listener(move |view, _, window, cx| view.pick(id, window, cx)));
    if current {
        row = row.tag(Tag::new(("first-run-tag", index), copy.current).tone(TagTone::Accent));
    }
    row.into_any_element()
}

fn more_tile(
    id: CardId,
    current: bool,
    snap: &Snapshot,
    copy: &Words,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let (state, description) = card_view(id, true, snap, copy);
    let index = id as usize;
    ChoiceTile::new(
        ("first-run-tile", index),
        glyph(id, ProviderLogoSize::Md, IconSize::Md, cx),
        copy.names[index],
    )
    .description(description)
    .state(state)
    .selected(current)
    .on_click(cx.listener(move |view, _, window, cx| view.pick(id, window, cx)))
    .into_any_element()
}

/// Butler is still preparing: the pick is kept and connects once it is ready.
fn preparing(text: &'static str) -> AnyElement {
    Stack::row()
        .gap(Space::Sm)
        .cross(Cross::Center)
        .child(Spinner::new("first-run-prep-spinner").size(14.))
        .child(Typo::caption(text).tone(Tone::Secondary))
        .into_any_element()
}

fn snapshot(view: &Onboarding, lang: Lang, cx: &Context<Onboarding>) -> Snapshot {
    let local = view.providers.read(cx);
    let (top, more) = layout(local.reachable());
    Snapshot {
        online: local.online(),
        found: local.found(lang),
        more_open: local.more_open,
        top,
        more,
    }
}

pub(crate) fn screen(
    view: &Onboarding,
    _window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let lang = view.lang;
    let (copy, shared) = (words(lang), shared_words(lang));
    let snap = snapshot(view, lang, cx);
    let current = view.current_card_id(cx);
    // Run setup again opens "more" when the AI in use is there.
    let expanded = snap
        .more_open
        .unwrap_or_else(|| current.is_some_and(|id| snap.more.contains(&id)));

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
        .map(|id| top_card(*id, current == Some(*id), &snap, copy, cx))
        .collect::<Vec<_>>();
    body.push(ChoiceCardList::new().children(cards).into_any_element());
    if expanded {
        let tiles = snap
            .more
            .iter()
            .map(|id| more_tile(*id, current == Some(*id), &snap, copy, cx))
            .collect::<Vec<_>>();
        body.push(
            ChoiceTileGrid::new("first-run-more-providers")
                .children(tiles)
                .into_any_element(),
        );
    }

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
        .on_click(cx.listener(move |view, _, _, cx| {
            view.providers.update(cx, |local, cx| {
                local.more_open = Some(!expanded);
                cx.notify();
            });
        }));
    step_card(view, copy.title, body, cx)
        .content_key("providers")
        .description(copy.lede)
        .on_back(
            shared.back,
            cx.listener(|view, _, _, cx| view.back_from_connect(cx)),
        )
        .footer_start(toggle)
        .into_any_element()
}
