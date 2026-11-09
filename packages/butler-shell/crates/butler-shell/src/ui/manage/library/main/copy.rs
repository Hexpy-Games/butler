//! The 서랍 main screen, kind view, toolbar and card copy. Each field names its
//! `packages/butler-i18n` key.
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

use crate::ui::manage::LibraryKind;

/// `library.groups.<scrap|bookmark>`
pub(crate) struct GroupWords {
    /// library.groups.*.ungrouped
    pub(crate) ungrouped: &'static str,
    /// library.groups.*.newGroup
    pub(crate) new_group: &'static str,
    /// library.groups.*.moveTo
    pub(crate) move_to: &'static str,
    /// library.groups.*.ungroup
    pub(crate) ungroup: &'static str,
    /// library.groups.*.count
    pub(crate) count: fn(i64) -> String,
    /// library.groups.*.more
    pub(crate) more: fn(usize) -> String,
}

pub(crate) struct Words {
    /// library.title
    pub(crate) title: &'static str,
    /// library.kinds: scrap, document, bookmark, output
    kinds: [&'static str; 4],
    /// library.search
    pub(crate) search: &'static str,
    /// library.kinds.all
    pub(crate) all: &'static str,
    /// library.kindLabel
    pub(crate) kind_label: &'static str,
    /// library.viewAll
    pub(crate) view_all: &'static str,
    /// library.empty
    pub(crate) empty: &'static str,
    /// library.noItems
    pub(crate) no_items: &'static str,
    /// library.failed
    pub(crate) failed: &'static str,
    /// library.open
    pub(crate) open: &'static str,
    /// library.rename
    pub(crate) rename: &'static str,
    /// library.editTags
    pub(crate) edit_tags: &'static str,
    /// library.name
    pub(crate) name: &'static str,
    /// library.tags
    pub(crate) tags: &'static str,
    /// library.manageTags
    pub(crate) manage_tags: &'static str,
    /// library.sites
    pub(crate) sites: &'static str,
    /// library.date
    pub(crate) date: &'static str,
    /// library.anyDate
    pub(crate) any_date: &'static str,
    /// library.dates: today, week, month, year
    pub(crate) dates: [&'static str; 4],
    /// library.since
    pub(crate) since: &'static str,
    /// library.until
    pub(crate) until: &'static str,
    /// library.sort
    pub(crate) sort: &'static str,
    /// library.sorts: new, old, name, site
    pub(crate) sorts: [&'static str; 4],
    /// library.filterChip
    pub(crate) filter_chip: fn(&str, &str) -> String,
    /// library.clearFilters
    pub(crate) clear_filters: &'static str,
    /// library.clearAll
    pub(crate) clear_all: &'static str,
    /// library.selected
    pub(crate) selected: fn(usize) -> String,
    /// library.select
    pub(crate) select: &'static str,
    /// library.cancel
    pub(crate) cancel: &'static str,
    /// library.deleteItem
    pub(crate) delete_item: &'static str,
    /// library.tileLabel
    pub(crate) tile_label: fn(&str, &str) -> String,
    /// library.dropAdd
    pub(crate) drop_add: fn(&str) -> String,
    /// browser.more
    pub(crate) more: &'static str,
    /// browser.loadMore
    pub(crate) load_more: &'static str,
    /// browser.attach
    pub(crate) attach: &'static str,
    /// browser.openSource
    pub(crate) open_source: &'static str,
    /// fileViewer.goToChat
    pub(crate) go_to_chat: &'static str,
    /// browser.element
    pub(crate) element: &'static str,
    /// browser.document
    pub(crate) document: &'static str,
    /// browser.bookmarks
    pub(crate) bookmark: &'static str,
    /// browser.output
    pub(crate) output: &'static str,
    /// conversation.answerBlocks.block
    pub(crate) block: &'static str,
    /// settings.pageSections.browserImport
    pub(crate) browser_import: &'static str,
    scrap: GroupWords,
    bookmark_groups: GroupWords,
    lang: Lang,
}

static KO: Words = Words {
    title: "서랍",
    kinds: ["스크랩", "문서", "북마크", "결과물"],
    search: "서랍 검색",
    all: "전체",
    kind_label: "종류",
    view_all: "모두 보기",
    empty: "비어 있음",
    no_items: "항목 없음",
    failed: "서랍을 불러오지 못함",
    open: "열기",
    rename: "이름 변경",
    edit_tags: "태그 편집…",
    name: "이름",
    tags: "태그",
    manage_tags: "태그 관리…",
    sites: "사이트",
    date: "기간",
    any_date: "전체 기간",
    dates: ["오늘", "지난 7일", "지난 30일", "올해"],
    since: "시작",
    until: "끝",
    sort: "정렬",
    sorts: ["최근 저장순", "오래된 순", "이름순", "사이트순"],
    filter_chip: |label, value| format!("{label}: {value}"),
    clear_filters: "필터 지우기",
    clear_all: "모두 지우기",
    selected: |count| format!("{count}개 선택됨"),
    select: "선택",
    cancel: "취소",
    delete_item: "삭제",
    tile_label: |name, meta| format!("{name}, {meta}"),
    drop_add: |group| format!("‘{group}’에 넣기"),
    more: "더 보기",
    load_more: "더 보기",
    attach: "대화에 첨부",
    open_source: "원본 열기",
    go_to_chat: "대화로 이동",
    element: "요소",
    document: "문서",
    bookmark: "북마크",
    output: "출력물",
    block: "블록",
    browser_import: "다른 브라우저에서 가져오기",
    scrap: GroupWords {
        ungrouped: "그룹 없음",
        new_group: "새 그룹",
        move_to: "그룹으로 이동",
        ungroup: "그룹 해제",
        count: |count| format!("스크랩 {count}개"),
        more: |count| format!("그룹 {count}개 더"),
    },
    bookmark_groups: GroupWords {
        ungrouped: "폴더 없음",
        new_group: "새 폴더",
        move_to: "폴더로 이동",
        ungroup: "폴더 해제",
        count: |count| format!("북마크 {count}개"),
        more: |count| format!("폴더 {count}개 더"),
    },
    lang: Lang::Ko,
};

static EN: Words = Words {
    title: "Library",
    kinds: ["Scraps", "Documents", "Bookmarks", "Outputs"],
    search: "Search the library",
    all: "All",
    kind_label: "Kind",
    view_all: "View all",
    empty: "Empty",
    no_items: "No items",
    failed: "Could not load the library",
    open: "Open",
    rename: "Rename",
    edit_tags: "Edit tags…",
    name: "Name",
    tags: "Tags",
    manage_tags: "Manage tags…",
    sites: "Sites",
    date: "Date",
    any_date: "Any time",
    dates: ["Today", "Last 7 days", "Last 30 days", "This year"],
    since: "From",
    until: "To",
    sort: "Sort",
    sorts: ["Newest", "Oldest", "Name", "Site"],
    filter_chip: |label, value| format!("{label}: {value}"),
    clear_filters: "Clear filters",
    clear_all: "Clear all",
    selected: |count| format!("{count} selected"),
    select: "Select",
    cancel: "Cancel",
    delete_item: "Delete",
    tile_label: |name, meta| format!("{name}, {meta}"),
    drop_add: |group| format!("Add to “{group}”"),
    more: "More",
    load_more: "More",
    attach: "Attach to chat",
    open_source: "Open source",
    go_to_chat: "Go to chat",
    element: "Element",
    document: "Document",
    bookmark: "Bookmarks",
    output: "Output",
    block: "Block",
    browser_import: "Import from another browser",
    scrap: GroupWords {
        ungrouped: "Ungrouped",
        new_group: "New group",
        move_to: "Move to group",
        ungroup: "Ungroup",
        count: |count| format!("{count} scrap{}", if count == 1 { "" } else { "s" }),
        more: |count| format!("{count} more group{}", if count == 1 { "" } else { "s" }),
    },
    bookmark_groups: GroupWords {
        ungrouped: "No folder",
        new_group: "New folder",
        move_to: "Move to folder",
        ungroup: "Remove folder",
        count: |count| format!("{count} bookmark{}", if count == 1 { "" } else { "s" }),
        more: |count| format!("{count} more folder{}", if count == 1 { "" } else { "s" }),
    },
    lang: Lang::En,
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// The copy of the app language.
pub(crate) fn get(cx: &App) -> &'static Words {
    words(Ds::get(cx).lang())
}

impl Words {
    /// `library.groups[kind]`: scraps have groups, bookmarks folders.
    pub(crate) fn groups(&self, kind: LibraryKind) -> &GroupWords {
        match kind {
            LibraryKind::Bookmark => &self.bookmark_groups,
            _ => &self.scrap,
        }
    }

    /// `library.kinds[kind]`
    pub(crate) fn kind(&self, kind: LibraryKind) -> &'static str {
        self.kinds[match kind {
            LibraryKind::Scrap => 0,
            LibraryKind::Document => 1,
            LibraryKind::Bookmark => 2,
            LibraryKind::Output => 3,
        }]
    }

    pub(crate) fn lang(&self) -> Lang {
        self.lang
    }
}
