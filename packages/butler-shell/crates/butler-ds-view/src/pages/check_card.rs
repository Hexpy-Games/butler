//! CheckCard.showcase.tsx: a live list of four (one blocked with its reason), the motion note
//! with a plain list, mixed one-line and two-line cards, and items with and without an icon.
//! The React state matrix has no counterpart in the viewer.
use std::collections::HashMap;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::check_card::{CheckCard, CheckCardList};
use butler_ds::ui::blocks::choice_card::glyph;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, Entity, IntoElement as _, ParentElement as _, Window};

use super::{Story, sub};
use crate::copy::Lang;
use crate::standins_overlay::provider_logo;

struct Copy {
    bookmarks: &'static str,
    passwords: &'static str,
    history: &'static str,
    keychain: &'static str,
    instructions: &'static str,
    needs_key: &'static str,
    empty: &'static str,
    holds: &'static str,
    servers: &'static str,
    motion: &'static str,
    mixed: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            bookmarks: "Bookmarks",
            passwords: "Passwords",
            history: "History",
            keychain: "Needs Keychain access",
            instructions: "Instructions",
            needs_key: "MCP server · Needs a key",
            empty: "Empty file",
            holds: "Instructions · 3 MCP servers",
            servers: "2 MCP servers",
            motion: "Click, tap or press Space. Check: the ring fills from the centre and the check draws in (220 ms). Uncheck: the check undraws, then the fill clears (170 ms). Press: the pressed fill of a wide row fades in under the content (120 ms); the card never shrinks. Interrupting a toggle reverses it from where it is. Reduced motion: fades only, no scale or stroke draw.",
            mixed: "One-line and two-line cards mixed: every glyph, logos included, is the title's text size on the title line; the check circle is centered on each card.",
        },
        Copy {
            bookmarks: "북마크",
            passwords: "비밀번호",
            history: "방문 기록",
            keychain: "키체인 접근 필요",
            instructions: "지침",
            needs_key: "MCP 서버 · 키 입력 필요",
            empty: "비어 있는 파일",
            holds: "지침 · MCP 서버 3개",
            servers: "MCP 서버 2개",
            motion: "누르거나 탭하거나 Space를 눌러 보세요. 체크: 원이 가운데서 채워지고 체크가 그려집니다(220ms). 해제: 체크가 지워진 뒤 채움이 빠집니다(170ms). 누를 때: 넓은 행의 눌림 색이 내용 아래에 옅게 깔립니다(120ms). 카드는 줄어들지 않습니다. 도중에 다시 누르면 그 자리에서 되돌아갑니다. 동작 줄이기: 크기 변화와 선 그리기 없이 페이드만 남습니다.",
            mixed: "한 줄과 두 줄 카드를 섞은 목록: 아이콘은 로고까지 모두 제목 글자 크기로 제목 줄에 맞추고, 체크 원은 카드마다 세로 가운데에 둡니다.",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Pick several (default)",
            render: item_list,
        },
        Story {
            name: "Motion: check, uncheck and press (live)",
            render: |lang, window, cx| {
                let note = copy(lang).motion;
                note_over(note, plain_list(lang, "ck-motion", window, cx))
            },
        },
        Story {
            name: "Mixed one-line and two-line cards",
            render: |lang, window, cx| {
                let note = copy(lang).mixed;
                note_over(note, mixed_list(lang, window, cx))
            },
        },
        Story {
            name: "Items to include (icons, and one without)",
            render: |lang, window, cx| plain_list(lang, "ck-plain", window, cx),
        },
    ]
}

fn note_over(note: &'static str, list: AnyElement) -> AnyElement {
    Stack::new()
        .gap(Space::Sm)
        .child(Typo::caption(note).tone(Tone::Secondary))
        .child(list)
        .into_any_element()
}

type Picked = Entity<HashMap<&'static str, bool>>;

fn picked(
    id: &'static str,
    initial: &[(&'static str, bool)],
    window: &mut Window,
    cx: &mut App,
) -> Picked {
    let initial: HashMap<_, _> = initial.iter().copied().collect();
    window.use_keyed_state(sub(id, "picked"), cx, move |_, _| initial)
}

/// A card for `key` that reads and writes its checked flag in `picked`.
fn card(
    id: &'static str,
    key: &'static str,
    title: &'static str,
    picked: &Picked,
    cx: &App,
) -> CheckCard {
    let state = picked.clone();
    let checked = picked.read(cx).get(key).copied().unwrap_or(false);
    CheckCard::new(sub(id, key), title, checked, move |on, _, cx| {
        state.update(cx, |map, cx| {
            map.insert(key, on);
            cx.notify();
        });
    })
}

/// Four cards: checked, unchecked, with a description, and blocked with its reason.
fn item_list(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let id = "ck-items";
    let on = picked(id, &[("claude", true), ("linear", true)], window, cx);
    let inert = format!("~/.codex/AGENTS.md · {}", c.empty);
    CheckCardList::new()
        .child(
            card(id, "claude", "Claude Code", &on, cx)
                .icon(provider_logo("claude"))
                .description(c.holds),
        )
        .child(
            card(id, "codex", "Codex", &on, cx)
                .icon(provider_logo("openai"))
                .description(c.servers),
        )
        .child(
            card(id, "linear", "linear", &on, cx)
                .icon(glyph(Icon::Server, cx))
                .description(c.needs_key),
        )
        .child(
            CheckCard::new(sub(id, "instructions"), c.instructions, false, |_, _, _| {})
                .icon(glyph(Icon::FileText, cx))
                .description(inert)
                .disabled_reason(c.empty),
        )
        .into_any_element()
}

fn plain_list(lang: Lang, id: &'static str, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let on = picked(id, &[("bookmarks", true), ("history", true)], window, cx);
    CheckCardList::new()
        .child(card(id, "bookmarks", c.bookmarks, &on, cx).icon(glyph(Icon::Bookmark, cx)))
        .child(card(id, "passwords", c.passwords, &on, cx).icon(glyph(Icon::Key, cx)))
        .child(card(id, "history", c.history, &on, cx).icon(glyph(Icon::History, cx)))
        .child(
            CheckCard::new(sub(id, "keychain"), c.passwords, false, |_, _, _| {})
                .description(c.keychain),
        )
        .into_any_element()
}

/// One-line and two-line cards in one list (instructions alone, servers with a note).
fn mixed_list(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let id = "ck-mixed";
    let on = picked(
        id,
        &[
            ("instructions", true),
            ("linear", true),
            ("bookmarks", true),
        ],
        window,
        cx,
    );
    CheckCardList::new()
        .child(card(id, "instructions", c.instructions, &on, cx).icon(glyph(Icon::FileText, cx)))
        .child(
            card(id, "linear", "linear", &on, cx)
                .icon(glyph(Icon::Server, cx))
                .description(c.needs_key),
        )
        .child(card(id, "files", "files", &on, cx).icon(glyph(Icon::Server, cx)))
        .child(card(id, "bookmarks", c.bookmarks, &on, cx).icon(glyph(Icon::Bookmark, cx)))
        .child(
            CheckCard::new(sub(id, "passwords"), c.passwords, false, |_, _, _| {})
                .icon(glyph(Icon::Key, cx))
                .description(c.keychain),
        )
        .into_any_element()
}
