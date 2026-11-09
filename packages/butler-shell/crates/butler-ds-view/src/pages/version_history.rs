//! VersionHistory.showcase.tsx: versions by the person and by Butler; picking an older one
//! shows the restore action.
use butler_ds::ui::blocks::version_history::{Author, VersionHistory, VersionHistoryEntry};
use butler_ds::ui::button::{Button, Size, Variant};
use gpui::{AnyElement, App, IntoElement as _, SharedString, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    me: &'static str,
    butler: &'static str,
    current: &'static str,
    list: &'static str,
    restore: &'static str,
    times: [&'static str; 4],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            me: "Me",
            butler: "Butler",
            current: "Current",
            list: "Versions",
            restore: "Restore",
            times: ["3:12 PM", "3:05 PM", "2:41 PM", "Yesterday"],
        },
        Copy {
            me: "나",
            butler: "버틀러",
            current: "현재",
            list: "버전 기록",
            restore: "되돌리기",
            times: ["오후 3:12", "오후 3:05", "오후 2:41", "어제"],
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![Story {
        name: "Versions by me and Butler",
        render: history,
    }]
}

fn history(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let selected = window.use_keyed_state("vh-selected", cx, |_, _| SharedString::from("4"));
    let authors = [Author::Butler, Author::User, Author::Butler, Author::User];
    let entries = authors
        .into_iter()
        .zip(c.times)
        .enumerate()
        .map(|(index, (author, time))| VersionHistoryEntry {
            id: (4 - index).to_string().into(),
            author,
            author_label: (if author == Author::Butler {
                c.butler
            } else {
                c.me
            })
            .into(),
            time: time.into(),
            date_time: None,
        })
        .collect();
    let current = selected.read(cx).clone();
    let state = selected.clone();
    let mut list = VersionHistory::new("vh", c.list, c.current, entries)
        .selected_id(current.clone())
        .on_select(move |id, _, cx| {
            state.update(cx, |selected, cx| {
                *selected = id;
                cx.notify();
            });
        });
    if current.as_ref() != "4" {
        list = list.action(
            Button::new("vh-restore")
                .size(Size::Sm)
                .variant(Variant::Secondary)
                .text(c.restore),
        );
    }
    list.into_any_element()
}
