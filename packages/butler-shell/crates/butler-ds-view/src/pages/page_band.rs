//! PageBand.showcase.tsx: every tone on a card top, at 736px, a Butler band that also carries a
//! blocked pop-up, and narrow cards where the hint and then the detail drop.
use butler_ds::tokens::{Color, Length, Shadow};
use butler_ds::ui::context::Ds;
use butler_ds::ui::convert::box_shadows;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement, ParentElement as _, Styled as _, Window, div, px};

use super::Story;
use crate::browser_demo::{BandKind, demo_band};
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Every tone",
            render: tones,
        },
        Story {
            // Acceptance: one line with two buttons at 736px; only the detail truncates.
            name: "At 736px: one line, two buttons",
            render: |l, _, c| on_card(Some(736.), "pb-736", BandKind::Agent, l, c),
        },
        Story {
            // Two states at once stay one line: the blocked pop-up becomes the detail.
            name: "Butler holds the tab and a pop-up is blocked: one band",
            render: |l, _, c| on_card(Some(736.), "pb-popup", BandKind::AgentPopup, l, c),
        },
        Story {
            name: "Narrow card: the hint drops, the detail truncates",
            render: narrow,
        },
    ]
}

/// `OnCard`: the band on the top edge of a card (`fixtures.module.css` `.cardTop`).
fn on_card(
    width: Option<f32>,
    id: &'static str,
    kind: BandKind,
    lang: Lang,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let card = div()
        .w_full()
        .overflow_hidden()
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .rounded(ds.len(Length::RadiusPopover))
        .bg(ds.color(Color::SurfaceRaised))
        .shadow(box_shadows(
            ds.tokens().shadow(Shadow::BrowserCardShadow),
            ds.tokens(),
        ))
        .child(demo_band(id, kind, lang, cx))
        // `.cardTop::after`: the card's body under the band.
        .child(div().h(ds.len(Length::Space2xl)));
    match width {
        Some(width) => card.max_w(px(width)),
        None => card,
    }
    .into_any_element()
}

fn tones(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let kinds = [
        (BandKind::Agent, "agent", "pb-tone-agent"),
        (BandKind::User, "user", "pb-tone-user"),
        (BandKind::Waiting, "waiting", "pb-tone-waiting"),
        (BandKind::NeedYou, "warning", "pb-tone-need"),
        (BandKind::Pick, "pick", "pb-tone-pick"),
        (BandKind::Popup, "info", "pb-tone-info"),
    ];
    Stack::new()
        .gap(Space::Md)
        .children(kinds.map(|(kind, tone, id)| {
            Stack::new()
                .gap(Space::Xs)
                .child(Typo::caption(tone).tone(Tone::Tertiary))
                .child(on_card(None, id, kind, lang, cx))
        }))
        .into_any_element()
}

fn narrow(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    Stack::new()
        .gap(Space::Sm)
        .child(on_card(Some(480.), "pb-480", BandKind::Pick, lang, cx))
        .child(on_card(Some(420.), "pb-420", BandKind::Waiting, lang, cx))
        .into_any_element()
}
