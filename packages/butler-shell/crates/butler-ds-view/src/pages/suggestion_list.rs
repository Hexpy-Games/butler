//! SuggestionList.showcase.tsx (+ SuggestionItems.demo.tsx): address suggestions with the typed
//! terms in bold, a keyboard highlight and a bookmark star; the composer `@` menu rows; and a live
//! list under a field. The browser's AddressField is a browser-pane block (P5): a DS Input stands
//! in for it, so arrow keys and Enter are not handled, and favicons are glyphs.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::suggestion_list::{
    SuggestionItemRow, SuggestionKind, SuggestionList, SuggestionRow,
};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::overlay::place::Align;
use butler_ds::ui::popover::{Density, Popover, PopoverContent, Width};
use butler_ds::ui::text::Input;
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    Window, div,
};

use super::Story;
use crate::copy::Lang;

struct Address {
    title: &'static str,
    url: &'static str,
    kind: SuggestionKind,
}

struct Copy {
    query: &'static str,
    items: [Address; 4],
}

fn copy(lang: Lang) -> Copy {
    let at = |title, url, kind| Address { title, url, kind };
    let history = SuggestionKind::History;
    lang.pick(
        Copy {
            query: "docs",
            items: [
                at(
                    "Docs - Getting started",
                    "https://docs.example.com/guides/getting-started",
                    SuggestionKind::Bookmark,
                ),
                at(
                    "Release notes",
                    "https://docs.example.com/changelog?tab=desktop",
                    history,
                ),
                at(
                    "Shared docs folder",
                    "https://drive.example.net/folders/team-docs",
                    history,
                ),
                at("", "https://status.example.org/docs", history),
            ],
        },
        Copy {
            query: "문서",
            items: [
                at(
                    "개발 문서 - 시작하기",
                    "https://docs.example.com/guides/getting-started",
                    SuggestionKind::Bookmark,
                ),
                at(
                    "릴리스 문서",
                    "https://docs.example.com/changelog?tab=desktop",
                    history,
                ),
                at(
                    "팀 공유 문서 폴더",
                    "https://drive.example.net/folders/team-docs",
                    history,
                ),
                at("", "https://status.example.org/문서", history),
            ],
        },
    )
}

#[derive(Clone, Copy)]
enum AppKind {
    ProjectChat,
    Project,
    Chat,
}

struct AppItem {
    kind: AppKind,
    title: &'static str,
    meta: Option<&'static str>,
}

struct Items {
    query: &'static str,
    items: [AppItem; 5],
}

fn items(lang: Lang) -> Items {
    use AppKind::{Chat, Project, ProjectChat};
    let at = |kind, title, meta| AppItem { kind, title, meta };
    lang.pick(
        Items {
            query: "design",
            items: [
                at(ProjectChat, "Design system cleanup", Some("butler")),
                at(Project, "Design research", Some("Project")),
                at(ProjectChat, "Composer design review", Some("butler")),
                at(Chat, "Landing page redesign", None),
                at(ProjectChat, "Interview notes", Some("Design research")),
            ],
        },
        Items {
            query: "디자인",
            items: [
                at(ProjectChat, "디자인 시스템 정리", Some("butler")),
                at(Project, "디자인 리서치", Some("프로젝트")),
                at(ProjectChat, "컴포저 디자인 검토", Some("butler")),
                at(Chat, "랜딩 페이지 리디자인", None),
                at(ProjectChat, "사용자 인터뷰 정리", Some("디자인 리서치")),
            ],
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Under the address field (type to filter)",
            render: live,
        },
        Story {
            name: "Matches in bold, keyboard highlight, bookmark star",
            render: |lang, _, _| address_rows(lang, "sl-matches", Some(1), true),
        },
        Story {
            name: "No query (recent pages)",
            render: |lang, _, _| address_rows(lang, "sl-recent", None, false),
        },
        Story {
            name: "App items: the composer @ menu, matches in bold",
            render: |lang, _, cx| item_rows(lang, "sl-items", Some(0), true, cx),
        },
        Story {
            name: "App items: bare @ (recent first)",
            render: |lang, _, cx| item_rows(lang, "sl-items-bare", Some(0), false, cx),
        },
    ]
}

fn address_rows(lang: Lang, id: &'static str, active: Option<usize>, query: bool) -> AnyElement {
    let c = copy(lang);
    let mut list = SuggestionList::new();
    for (index, item) in c.items.iter().enumerate() {
        let mut row = SuggestionRow::new((id, index), item.url, |_, _| {})
            .kind(item.kind)
            .active(active == Some(index))
            .query(if query { c.query } else { "" });
        if !item.title.is_empty() {
            row = row.title(item.title);
        }
        list = list.child(row);
    }
    list.into_any_element()
}

fn item_rows(
    lang: Lang,
    id: &'static str,
    active: Option<usize>,
    query: bool,
    cx: &App,
) -> AnyElement {
    let c = items(lang);
    let ds = Ds::get(cx);
    let mut list = SuggestionList::new();
    for (index, item) in c.items.iter().enumerate() {
        let glyph = match item.kind {
            AppKind::Project => Icon::Briefcase,
            AppKind::ProjectChat => Icon::Notebook,
            AppKind::Chat => Icon::MessageSquare,
        };
        let mut row = SuggestionItemRow::new(
            (id, index),
            icon(glyph, IconSize::Md, ds),
            item.title,
            |_, _| {},
        )
        .active(active == Some(index))
        .query(if query { c.query } else { "" });
        if let Some(meta) = item.meta {
            row = row.meta(meta);
        }
        if matches!(item.kind, AppKind::ProjectChat) {
            row = row.match_meta();
        }
        list = list.child(row);
    }
    list.into_any_element()
}

/// AddressSuggestions in miniature: type, and the list under the field filters; a click chooses.
fn live(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let query: Entity<SharedString> =
        window.use_keyed_state("sl-live-query", cx, |_, _| SharedString::default());
    let typed = query.read(cx).clone();
    let hits: Vec<&Address> = c
        .items
        .iter()
        .filter(|item| {
            !typed.is_empty()
                && format!("{} {}", item.title, item.url)
                    .to_lowercase()
                    .contains(&typed.to_lowercase())
        })
        .collect();
    let popover = Popover::new("sl-live-popover", window, cx).open(!hits.is_empty());
    let (set, chosen) = (query.clone(), query.clone());
    let field = Input::new("sl-live-field")
        .default_value("https://docs.example.com/")
        .on_change(move |text, _, cx| {
            let text = SharedString::from(text.to_owned());
            set.update(cx, |query, cx| {
                *query = text;
                cx.notify();
            });
        });
    let mut list = SuggestionList::new();
    for (index, item) in hits.iter().enumerate() {
        let chosen = chosen.clone();
        let mut row = SuggestionRow::new(("sl-live", index), item.url, move |_, cx| {
            chosen.update(cx, |query, cx| {
                *query = SharedString::default();
                cx.notify();
            });
        })
        .kind(item.kind)
        .query(typed.clone());
        if !item.title.is_empty() {
            row = row.title(item.title);
        }
        list = list.child(row);
    }
    let content = popover.content(
        PopoverContent::new()
            .align(Align::Start)
            .width(Width::Anchor)
            .density(Density::List)
            .child(list),
        window,
        cx,
    );
    div()
        .w_full()
        .child(popover.anchor(field))
        .child(content)
        .into_any_element()
}
