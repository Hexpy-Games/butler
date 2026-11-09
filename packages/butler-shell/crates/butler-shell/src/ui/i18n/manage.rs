//! The management frame's copy: view titles, the 서랍 level names and the titlebar back label.
//! Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

use crate::ui::manage::LibraryKind;

pub(crate) struct Words {
    /// library.title
    pub(crate) library_title: &'static str,
    /// browser.history.title
    pub(crate) history_title: &'static str,
    /// automations.title
    pub(crate) automations_title: &'static str,
    /// canon.overview
    pub(crate) canon_overview: &'static str,
    /// sidebar.projectDashboard
    pub(crate) project_dashboard: &'static str,
    /// library.kinds.scrap / document / bookmark / output
    kinds: [&'static str; 4],
    /// library.groups.scrap.ungrouped
    pub(crate) scrap_ungrouped: &'static str,
    /// library.groups.bookmark.ungrouped
    pub(crate) bookmark_ungrouped: &'static str,
    /// browser.failed
    pub(crate) browser_failed: &'static str,
    lang: Lang,
}

static KO: Words = Words {
    library_title: "서랍",
    history_title: "방문 기록",
    automations_title: "예약 작업",
    canon_overview: "계획 개요",
    project_dashboard: "프로젝트 대시보드",
    kinds: ["스크랩", "문서", "북마크", "결과물"],
    scrap_ungrouped: "그룹 없음",
    bookmark_ungrouped: "폴더 없음",
    browser_failed: "페이지를 열지 못함",
    lang: Lang::Ko,
};

static EN: Words = Words {
    library_title: "Library",
    history_title: "History",
    automations_title: "Schedules",
    canon_overview: "Plan overview",
    project_dashboard: "Project dashboard",
    kinds: ["Scraps", "Documents", "Bookmarks", "Outputs"],
    scrap_ungrouped: "Ungrouped",
    bookmark_ungrouped: "No folder",
    browser_failed: "Could not open page",
    lang: Lang::En,
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

impl Words {
    /// library.kinds[kind]
    pub(crate) fn kind(&self, kind: LibraryKind) -> &'static str {
        match kind {
            LibraryKind::Scrap => self.kinds[0],
            LibraryKind::Document => self.kinds[1],
            LibraryKind::Bookmark => self.kinds[2],
            LibraryKind::Output => self.kinds[3],
        }
    }

    /// library.back(title)
    pub(crate) fn back(&self, title: &str) -> String {
        match self.lang {
            Lang::Ko => format!("{title}{} 돌아가기", ro(title)),
            Lang::En => format!("Back to {title}"),
        }
    }
}

/// ko.ts `ro`: 로 after a vowel or ㄹ, 으로 after another final consonant, (으)로 after a
/// character that is not a Hangul syllable.
fn ro(word: &str) -> &'static str {
    let Some(code) = word
        .chars()
        .last()
        .and_then(|c| u32::from(c).checked_sub(0xAC00))
        .filter(|code| *code <= 11171)
    else {
        return "(으)로";
    };
    match code % 28 {
        0 | 8 => "로",
        _ => "으로",
    }
}
