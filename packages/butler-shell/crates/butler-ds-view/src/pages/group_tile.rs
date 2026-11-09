//! GroupTile.showcase.tsx: the mosaic of 4+, 3, 2, 1 and no items, a long name, a drop target and
//! the overflow tile; bookmark folders (favicon and host); two columns on a phone.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::group_tile::{GroupTile, GroupTileMore, GroupTilePreview};
use butler_ds::ui::blocks::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use butler_ds::ui::layout::{Columns, Grid, Preset, Responsive, Space};
use gpui::{AnyElement, App, IntoElement as _, SharedString, Window};

use super::Story;
use super::media_frame::fixtures::{Kind, picture_of};
use crate::copy::Lang;

struct Copy {
    more: &'static str,
    open: &'static str,
    rename: &'static str,
    ungroup: &'static str,
    empty: &'static str,
    view_all: &'static str,
    more_groups: &'static str,
    names: [&'static str; 7],
    scrap: fn(usize) -> String,
    drop: &'static str,
    folders: [&'static str; 2],
    bookmarks: fn(usize) -> String,
    quote: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            more: "More",
            open: "Open",
            rename: "Rename",
            ungroup: "Ungroup",
            empty: "Empty",
            view_all: "View all",
            more_groups: "3 more groups",
            names: [
                "Travel",
                "Camping gear",
                "Recipes",
                "Fall clothes",
                "Gift ideas",
                "Autumn month-long Jeju stay shortlist and neighborhood walks",
                "Work references",
            ],
            scrap: |n| format!("{n} scrap{} · Oct 10", if n == 1 { "" } else { "s" }),
            drop: "Add to “Work references”",
            folders: ["Work", "Reading"],
            bookmarks: |n| format!("{n} bookmarks · Oct 2"),
            quote: "Q4 goal: raise onboarding completion from 60% to 75%.",
        },
        Copy {
            more: "더 보기",
            open: "열기",
            rename: "이름 변경",
            ungroup: "그룹 해제",
            empty: "비어 있음",
            view_all: "모두 보기",
            more_groups: "그룹 3개 더",
            names: [
                "여행",
                "캠핑 장비",
                "레시피",
                "가을 옷",
                "선물 아이디어",
                "2026 가을 제주 한 달 살기 숙소 후보와 동네 산책 코스 모음",
                "업무 참고",
            ],
            scrap: |n| format!("스크랩 {n}개 · 10. 10."),
            drop: "‘업무 참고’에 넣기",
            folders: ["업무", "읽을거리"],
            bookmarks: |n| format!("북마크 {n}개 · 10. 2."),
            quote: "Q4 목표: 신규 사용자 온보딩 완료율 60% → 75%.",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "States: 4+, 3, 2, 1, empty, long name, drop target, overflow",
            render: states,
        },
        Story {
            name: "Bookmark folders (favicon and host)",
            render: bookmarks,
        },
        Story {
            name: "Phone: two columns",
            render: phone,
        },
    ]
}

fn columns(base: u8, compact: u8) -> Columns {
    Columns::Responsive(Responsive {
        compact: Some(compact),
        base: Preset::Fixed(base),
        wide: None,
    })
}

/// The first `count` of five pictures.
fn previews(count: usize) -> Vec<GroupTilePreview> {
    [
        Kind::Product,
        Kind::Paper,
        Kind::Strip,
        Kind::Recipe,
        Kind::Place,
    ]
    .into_iter()
    .take(count)
    .map(|kind| GroupTilePreview::Image {
        src: picture_of(kind),
    })
    .collect()
}

fn menu(id: String, c: &Copy) -> OverflowActionMenu {
    OverflowActionMenu::new(id, c.more)
        .item(OverflowItem::new(c.open).icon(Icon::FolderOpen))
        .item(OverflowItem::new(c.rename).icon(Icon::PencilLine))
        .item(OverflowItem::new(c.ungroup).icon(Icon::X).destructive())
}

fn states(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let tile = |index: usize, count: usize, drop: bool| {
        let shown = if drop {
            vec![
                GroupTilePreview::Quote {
                    text: c.quote.into(),
                },
                GroupTilePreview::Document,
            ]
        } else {
            previews(count)
        };
        GroupTile::new(format!("gt-{index}"), c.names[index], shown, c.empty)
            .meta((c.scrap)(count))
            .menu(menu(format!("gt-{index}-menu"), &c))
            .drop(drop)
            .drop_hint(c.drop)
            .on_open(|_, _, _| {})
    };
    Grid::new("gt-states")
        .columns(columns(4, 1))
        .gap(Space::Md)
        .child(tile(0, 5, false))
        .child(tile(1, 3, false))
        .child(tile(2, 2, false))
        .child(tile(3, 1, false))
        .child(tile(4, 0, false))
        .child(tile(5, 4, false))
        .child(tile(6, 2, true))
        .child(
            GroupTileMore::new("gt-more", 3, c.more_groups)
                .meta(c.view_all)
                .on_open(|_, _, _| {}),
        )
        .into_any_element()
}

fn site(host: &'static str) -> GroupTilePreview {
    GroupTilePreview::Site {
        host: SharedString::new_static(host),
        icon: None,
    }
}

fn bookmarks(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let reading = [
        "notes.example.org",
        "blog.example.dev",
        "news.example.kr",
        "maps.example.com",
    ]
    .map(site);
    Grid::new("gt-bookmarks")
        .columns(columns(4, 1))
        .gap(Space::Md)
        .child(
            GroupTile::new(
                "gt-work",
                c.folders[0],
                [site("docs.example.com"), site("ds.example.com")],
                c.empty,
            )
            .meta((c.bookmarks)(2))
            .on_open(|_, _, _| {}),
        )
        .child(
            GroupTile::new("gt-reading", c.folders[1], reading, c.empty)
                .meta((c.bookmarks)(4))
                .on_open(|_, _, _| {}),
        )
        .into_any_element()
}

fn phone(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let tile = |index: usize, count: usize| {
        GroupTile::new(
            format!("gt-phone-{index}"),
            c.names[index],
            previews(count),
            c.empty,
        )
        .meta((c.scrap)(count))
        .on_open(|_, _, _| {})
    };
    Grid::new("gt-phone")
        .columns(Columns::fixed(2))
        .gap(Space::Md)
        .child(tile(0, 5))
        .child(tile(2, 2))
        .child(tile(4, 0))
        .child(
            GroupTileMore::new("gt-phone-more", 3, c.more_groups)
                .meta(c.view_all)
                .on_open(|_, _, _| {}),
        )
        .into_any_element()
}
