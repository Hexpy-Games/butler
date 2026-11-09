//! HistoryRow.showcase.tsx: days of visits (hovering a row swaps the time for its actions) and
//! the selection mode, where each row is a check box. The React stories also show favicons; the
//! rows here use the globe a missing icon shows.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::history_row::{HistoryGroup, HistoryRow};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Space, Stack};
use gpui::{
    AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Styled as _, Window, div,
};

use super::Story;
use crate::copy::Lang;

struct Visit {
    id: usize,
    title: &'static str,
    url: &'static str,
    time: &'static str,
    conversation: bool,
}

struct Copy {
    today: &'static str,
    yesterday: &'static str,
    remove: &'static str,
    conversation: &'static str,
    visits: [Visit; 4],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            today: "Today - Sunday, October 11, 2026",
            yesterday: "Yesterday - Saturday, October 10, 2026",
            remove: "Delete",
            conversation: "Open conversation",
            visits: [
                Visit {
                    id: 1,
                    title: "Docs - Getting started with the desktop app",
                    url: "https://docs.example.com/guides/getting-started",
                    time: "8:27 PM",
                    conversation: false,
                },
                Visit {
                    id: 2,
                    title: "Inbox (3)",
                    url: "https://mail.example.net/inbox",
                    time: "8:12 PM",
                    conversation: true,
                },
                Visit {
                    id: 3,
                    title: "Office chairs - Shop",
                    url: "https://shop.example.com/search?q=office-chair",
                    time: "11:04 AM",
                    conversation: false,
                },
                Visit {
                    id: 4,
                    title: "",
                    url: "https://status.example.org/",
                    time: "9:30 AM",
                    conversation: false,
                },
            ],
        },
        Copy {
            today: "오늘 - 2026년 10월 11일 일요일",
            yesterday: "어제 - 2026년 10월 10일 토요일",
            remove: "삭제",
            conversation: "대화 열기",
            visits: [
                Visit {
                    id: 1,
                    title: "개발 문서 - 데스크톱 앱 시작하기",
                    url: "https://docs.example.com/guides/getting-started",
                    time: "오후 08:27",
                    conversation: false,
                },
                Visit {
                    id: 2,
                    title: "받은편지함 (3)",
                    url: "https://mail.example.net/inbox",
                    time: "오후 08:12",
                    conversation: true,
                },
                Visit {
                    id: 3,
                    title: "사무용 의자 - 쇼핑",
                    url: "https://shop.example.com/search?q=office-chair",
                    time: "오전 11:04",
                    conversation: false,
                },
                Visit {
                    id: 4,
                    title: "",
                    url: "https://status.example.org/",
                    time: "오전 09:30",
                    conversation: false,
                },
            ],
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Days of visits (hover shows the actions)",
            render: |lang, window, cx| days(lang, false, window, cx),
        },
        Story {
            name: "Selection mode",
            render: |lang, window, cx| days(lang, true, window, cx),
        },
    ]
}

fn actions(c: &Copy, visit: &Visit, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let label: SharedString = format!(
        "{}: {}",
        c.remove,
        if visit.title.is_empty() {
            visit.url
        } else {
            visit.title
        }
    )
    .into();
    let mut row = div().flex().items_center();
    if visit.conversation {
        row = row.child(
            IconButton::new(
                SharedString::from(format!("hr-chat-{}", visit.id)),
                c.conversation,
            )
            .icon(icon(Icon::MessageSquare, IconSize::Md, ds)),
        );
    }
    row.child(
        IconButton::new(SharedString::from(format!("hr-del-{}", visit.id)), label).icon(icon(
            Icon::Trash2,
            IconSize::Md,
            ds,
        )),
    )
    .into_any_element()
}

fn day(
    c: &Copy,
    title: &'static str,
    visits: &[Visit],
    selecting: bool,
    picked: &gpui::Entity<Vec<usize>>,
    cx: &App,
) -> AnyElement {
    let mut group = HistoryGroup::new(title);
    for visit in visits {
        let id = visit.id;
        let state = picked.clone();
        let mut row = HistoryRow::new(
            SharedString::from(format!("hr-{id}")),
            visit.url,
            visit.time,
        )
        .on_open(|_, _| {})
        .actions(actions(c, visit, cx))
        .selecting(selecting)
        .selected(picked.read(cx).contains(&id))
        .on_selected_change(move |on, _, cx| {
            state.update(cx, |ids, cx| {
                ids.retain(|picked| *picked != id);
                if on {
                    ids.push(id);
                }
                cx.notify();
            });
        });
        if !visit.title.is_empty() {
            row = row.title(visit.title);
        }
        group = group.child(row);
    }
    group.into_any_element()
}

fn days(lang: Lang, selecting: bool, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let key = if selecting {
        "hr-picked-select"
    } else {
        "hr-picked-browse"
    };
    let picked = window.use_keyed_state(key, cx, |_, _| vec![2_usize]);
    Stack::new()
        .gap(Space::Lg)
        .child(day(&c, c.today, &c.visits[..2], selecting, &picked, cx))
        .child(day(&c, c.yesterday, &c.visits[2..], selecting, &picked, cx))
        .into_any_element()
}
