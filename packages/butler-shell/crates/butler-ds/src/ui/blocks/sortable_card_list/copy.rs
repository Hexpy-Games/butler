//! The accessible names and the default empty message of a SortableCardList (React has them
//! in English only, inline: `Reorder ${label}`, `Remove ${label}`, `No cards configured yet.`).
use crate::ui::context::Lang;

pub(super) fn reorder(lang: Lang, label: &str) -> String {
    match lang {
        Lang::En => format!("Reorder {label}"),
        Lang::Ko => format!("{label} 순서 바꾸기"),
    }
}

pub(super) fn remove(lang: Lang, label: &str) -> String {
    match lang {
        Lang::En => format!("Remove {label}"),
        Lang::Ko => format!("{label} 삭제"),
    }
}

pub(super) fn empty(lang: Lang) -> &'static str {
    match lang {
        Lang::En => "No cards configured yet.",
        Lang::Ko => "아직 구성된 카드가 없습니다.",
    }
}
