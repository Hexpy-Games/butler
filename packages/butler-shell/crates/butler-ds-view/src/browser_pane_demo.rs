//! The browser pane as the app composes it (BrowserPane `fixtures/BrowserDemo.tsx`,
//! `ConversationFrame.tsx`; PageCard.demo.tsx): tab row, toolbar, page card with band. The page is
//! a plain coloured surface with its URL: the shell draws the real page. Not part of `butler-ds`.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::address_field::AddressField;
use butler_ds::ui::blocks::browser_pane::{BrowserPane, BrowserToolbar, PanePlacement};
use butler_ds::ui::blocks::page_card::{PageCard, PageCardBounds, PageCardHolder};
use butler_ds::ui::blocks::tab_strip::{Favicon, Group, GroupKind, Tab, TabState, TabStrip};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::typo::{Role, Tone, Typo};
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, Styled as _, Window, div, size,
};

use crate::browser_demo::{BandKind, copy, demo_band, sub};
use crate::copy::Lang;
use crate::pages::tab_strip_labels as tab_labels;

/// What `BrowserDemo` varies.
#[derive(Clone, Copy)]
pub(crate) struct PaneSpec {
    pub placement: PanePlacement,
    pub holder: PageCardHolder,
    pub band: Option<BandKind>,
    /// Butler's fixed 1280x800 page (fitted to the card's width).
    pub agent: bool,
    pub loading: Option<f32>,
}

impl PaneSpec {
    /// The `BrowserDemo` defaults: Butler holds the tab, with its band and its fixed page.
    pub(crate) const BUTLER: Self = Self {
        placement: PanePlacement::Conversation,
        holder: PageCardHolder::Butler,
        band: Some(BandKind::Agent),
        agent: true,
        loading: None,
    };
}

/// The page stand-in: a surface with the page's address.
pub(crate) fn page_surface(url: &'static str, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    div()
        .size_full()
        .bg(ds.color(Color::WorkspaceBg))
        .p(ds.len(Length::Space2xl))
        .child(Typo::new(Role::PanelTitle, url).tone(Tone::Secondary))
        .into_any_element()
}

/// The page card of the demos: the stand-in page, an optional band and loading line.
pub(crate) fn demo_card(
    id: &'static str,
    spec: PaneSpec,
    lang: Lang,
    reserve: bool,
    cx: &App,
) -> PageCard {
    let c = copy(lang);
    let mut card = PageCard::new(id)
        .holder(spec.holder)
        .page(page_surface(c.url, cx));
    if reserve {
        card = card.reserve_band();
    }
    if let Some(kind) = spec.band {
        card = card.band(demo_band(sub(id, "band"), kind, lang, cx));
    }
    if let Some(progress) = spec.loading {
        card = card.loading(progress);
    }
    if spec.agent {
        card = card.viewport(size(1280., 800.));
    }
    card
}

struct Words {
    browser: &'static str,
    conversation: &'static str,
    tab_title: &'static str,
    back: &'static str,
    forward: &'static str,
    reload: &'static str,
    pick: &'static str,
    scrap: &'static str,
    bookmarks: &'static str,
    more: &'static str,
    bring_tab: &'static str,
}

fn words(lang: Lang) -> Words {
    lang.pick(
        Words {
            browser: "Browser",
            conversation: "Office chair order",
            tab_title: "Office chairs : Daily Goods",
            back: "Back",
            forward: "Forward",
            reload: "Reload",
            pick: "Pick elements",
            scrap: "Scrap",
            bookmarks: "Bookmarks",
            more: "More",
            bring_tab: "Bring in a tab",
        },
        Words {
            browser: "브라우저",
            conversation: "사무용 의자 주문",
            tab_title: "사무용 의자 : 데일리굿즈",
            back: "뒤로",
            forward: "앞으로",
            reload: "새로고침",
            pick: "요소 선택",
            scrap: "스크랩",
            bookmarks: "북마크",
            more: "더 보기",
            bring_tab: "내 탭 가져오기",
        },
    )
}

fn tabs(id: &'static str, spec: PaneSpec, lang: Lang, w: &Words) -> TabStrip {
    let mut tab = Tab::new("t1", w.tab_title).favicon(Favicon::Letter {
        rgb: 0x001f_8f5f,
        letter: 'S',
    });
    if spec.holder == PageCardHolder::Butler {
        tab = tab.state(TabState::Working);
    }
    let group = Group::new("c", GroupKind::Conversation)
        .label(w.conversation)
        .tab(tab);
    let mut strip = TabStrip::new(sub(id, "tabs"), vec![group])
        .active(Some("t1".into()))
        .labels(tab_labels(lang))
        .on_activate(|_, _, _| {})
        .on_close(|_, _, _| {})
        .on_new_tab(|_, _| {})
        .on_new_tab_in_group(|_, _, _| {});
    if spec.placement == PanePlacement::Conversation {
        strip = strip
            .hide_chip()
            .child(IconButton::new(sub(id, "bring"), w.bring_tab).glyph(Icon::TabIn));
    }
    strip
}

fn toolbar(
    id: &'static str,
    spec: PaneSpec,
    lang: Lang,
    w: &Words,
    starred: Entity<bool>,
    cx: &App,
) -> BrowserToolbar {
    let c = copy(lang);
    let bookmarked = *starred.read(cx);
    let button = |key: &'static str, label: &'static str, glyph: Icon| {
        IconButton::new(sub(id, key), label).glyph(glyph)
    };
    BrowserToolbar::new(sub(id, "toolbar"))
        .navigation(button("back", w.back, Icon::ArrowLeft))
        .navigation(button("forward", w.forward, Icon::ArrowRight).disabled())
        .navigation(button("reload", w.reload, Icon::RefreshCcw))
        .address(
            AddressField::new(sub(id, "address"))
                .url(c.url)
                .on_submit(|_, _, _| {})
                .bookmarked(bookmarked)
                .on_toggle_bookmark(move |_, cx| starred.update(cx, |on, _| *on = !*on)),
        )
        .action(button("pick", w.pick, Icon::Pick).pressed(spec.band == Some(BandKind::Pick)))
        .action(button("scrap", w.scrap, Icon::Scrap))
        .action(button("bookmarks", w.bookmarks, Icon::Bookmark))
        .action(button("more", w.more, Icon::MoreHorizontal))
}

/// `BrowserDemo`: the pane with its tab row, toolbar and page card.
pub(crate) fn demo_pane(
    id: &'static str,
    spec: PaneSpec,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let w = words(lang);
    let starred: Entity<bool> = window.use_keyed_state(sub(id, "starred"), cx, |_, _| false);
    let card = demo_card(id, spec, lang, false, cx);
    BrowserPane::new(
        id,
        w.browser,
        tabs(id, spec, lang, &w),
        toolbar(id, spec, lang, &w, starred, cx),
        card,
    )
    .placement(spec.placement)
    .holder(spec.holder)
    .into_any_element()
}

/// The `readout` line of the PageCard demos: where the page is and the radius it takes.
pub(crate) fn readout(bounds: Option<PageCardBounds>, waiting: &'static str) -> String {
    bounds.map_or_else(
        || waiting.to_owned(),
        |b| {
            let f = |p: gpui::Pixels| f32::from(p).round();
            format!(
                "x {} · y {} · {} × {} · radius {} · scale {:.2}",
                f(b.bounds.origin.x),
                f(b.bounds.origin.y),
                f(b.bounds.size.width),
                f(b.bounds.size.height),
                f(b.radius),
                b.scale
            )
        },
    )
}
