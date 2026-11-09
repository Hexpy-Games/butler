//! The copy of the 서랍 detail, dialogs and attach dialog (`appCopy.library`, `browser`,
//! `documents`, `artifacts`, `space`). Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

use crate::ui::manage::LibraryKind;

/// `library.groups.<scrap | bookmark>`
pub(super) struct GroupWords {
    /// word
    pub(super) word: &'static str,
    /// ungrouped
    pub(super) ungrouped: &'static str,
    /// newGroup
    pub(super) new_group: &'static str,
    /// createGroup
    pub(super) create_group: &'static str,
    /// groupName
    pub(super) group_name: &'static str,
    /// renameGroup
    pub(super) rename_group: &'static str,
    /// ungroup
    pub(super) ungroup: &'static str,
    /// moveTo
    pub(super) move_to: &'static str,
    /// ungroupTitle
    pub(super) ungroup_title: fn(&str) -> String,
    /// ungroupBody
    pub(super) ungroup_body: fn(i64) -> String,
}

pub(super) struct Words {
    /// library.name
    pub(super) name: &'static str,
    /// library.tags
    pub(super) tags: &'static str,
    /// library.addTag
    pub(super) add_tag: &'static str,
    /// library.createTag
    pub(super) create_tag: fn(&str) -> String,
    /// library.removeTag
    pub(super) remove_tag: fn(&str) -> String,
    /// library.manageTags
    pub(super) manage_tags: &'static str,
    /// library.noTags
    pub(super) no_tags: &'static str,
    /// library.merge
    pub(super) merge: &'static str,
    /// library.mergeNote
    pub(super) merge_note: fn(&str, i64, &str, i64) -> String,
    /// library.deleteTag
    pub(super) delete_tag: &'static str,
    /// library.rename
    pub(super) rename: &'static str,
    /// library.groupExists
    pub(super) group_exists: &'static str,
    /// library.failed
    pub(super) failed: &'static str,
    /// library.cancel
    pub(super) cancel: &'static str,
    /// library.create
    pub(super) create: &'static str,
    /// library.save
    pub(super) save: &'static str,
    /// library.move
    pub(super) move_items: &'static str,
    /// library.deleteItem
    pub(super) delete_item: &'static str,
    /// library.source
    pub(super) source: &'static str,
    /// library.saved
    pub(super) saved: &'static str,
    /// library.size
    pub(super) size: &'static str,
    /// library.undo
    pub(super) undo: &'static str,
    /// library.added
    pub(super) added: fn(i64, &str) -> String,
    /// library.savedScraps
    pub(super) saved_scraps: fn(i64) -> String,
    /// library.addToGroup
    pub(super) add_to_group: &'static str,
    /// library.leaveUngrouped
    pub(super) leave_ungrouped: &'static str,
    /// library.mixedKinds
    pub(super) mixed_kinds: &'static str,
    /// library.tagsOnSome
    pub(super) tags_on_some: fn(i64, i64) -> String,
    /// library.addToAll
    pub(super) add_to_all: &'static str,
    /// library.removeFromAll
    pub(super) remove_from_all: &'static str,
    /// library.bulkTagsTitle
    pub(super) bulk_tags_title: fn(i64) -> String,
    /// library.deleteSelected
    pub(super) delete_selected: fn(i64) -> String,
    /// library.deleteSelectedBody
    pub(super) delete_selected_body: &'static str,
    /// browser.more
    pub(super) more: &'static str,
    /// browser.failed
    pub(super) browser_failed: &'static str,
    /// browser.attachToChat
    pub(super) attach_to_chat: &'static str,
    /// browser.attach
    pub(super) attach: &'static str,
    /// browser.openSourcePage
    pub(super) open_source_page: &'static str,
    /// browser.emptyLibrary
    pub(super) empty_library: &'static str,
    /// browser.output, browser.document, browser.bookmarks
    pub(super) site_labels: [&'static str; 3],
    /// conversation.answerBlocks.openOriginChat
    pub(super) open_origin_chat: &'static str,
    /// space.search
    pub(super) search: &'static str,
    /// space.general
    pub(super) general: &'static str,
    /// artifacts.loading
    pub(super) artifact_loading: &'static str,
    /// artifacts.revision
    pub(super) revision: &'static str,
    /// documents.me, documents.butler
    pub(super) authors: [&'static str; 2],
    /// library.groups.scrap, library.groups.bookmark
    groups: [GroupWords; 2],
    pub(super) lang: Lang,
}

impl Words {
    pub(super) fn group(&self, kind: LibraryKind) -> &GroupWords {
        match kind {
            LibraryKind::Bookmark => &self.groups[1],
            _ => &self.groups[0],
        }
    }
}

static KO: Words = Words {
    name: "이름",
    tags: "태그",
    add_tag: "태그 추가",
    create_tag: |name| format!("‘{name}’ 태그 만들기"),
    remove_tag: |name| format!("{name} 빼기"),
    manage_tags: "태그 관리…",
    no_tags: "태그 없음",
    merge: "합치기",
    merge_note: |from, from_count, to, to_count| {
        format!("‘{from}’ {from_count}개와 ‘{to}’ {to_count}개를 합칩니다.")
    },
    delete_tag: "태그 삭제",
    rename: "이름 변경",
    group_exists: "같은 이름이 있습니다.",
    failed: "서랍을 불러오지 못함",
    cancel: "취소",
    create: "만들기",
    save: "저장",
    move_items: "이동",
    delete_item: "삭제",
    source: "원본",
    saved: "저장",
    size: "크기",
    undo: "실행 취소",
    added: |count, group| format!("{count}개를 ‘{group}’에 넣음"),
    saved_scraps: |count| format!("스크랩 {count}개 저장함"),
    add_to_group: "그룹에 넣기",
    leave_ungrouped: "그룹 없이 두기",
    mixed_kinds: "종류가 다른 항목은 함께 옮길 수 없습니다.",
    tags_on_some: |count, total| format!("{total}개 중 {count}"),
    add_to_all: "모두에 붙이기",
    remove_from_all: "모두에서 빼기",
    bulk_tags_title: |count| format!("태그 · {count}개"),
    delete_selected: |count| format!("{count}개를 삭제할까요?"),
    delete_selected_body: "삭제한 항목은 되돌릴 수 없습니다.",
    more: "더 보기",
    browser_failed: "페이지를 열지 못함",
    attach_to_chat: "대화에 첨부",
    attach: "대화에 첨부",
    open_source_page: "원본 페이지 열기",
    empty_library: "항목 없음",
    site_labels: ["출력물", "문서", "북마크"],
    open_origin_chat: "원래 대화 열기",
    search: "검색",
    general: "대화",
    artifact_loading: "아티팩트를 불러오는 중",
    revision: "버전",
    authors: ["나", "버틀러"],
    groups: [
        GroupWords {
            word: "그룹",
            ungrouped: "그룹 없음",
            new_group: "새 그룹",
            create_group: "그룹 만들기",
            group_name: "그룹 이름",
            rename_group: "그룹 이름 변경",
            ungroup: "그룹 해제",
            move_to: "그룹으로 이동",
            ungroup_title: |name| format!("‘{name}’ 그룹을 해제할까요?"),
            ungroup_body: |count| format!("스크랩 {count}개는 그대로 남습니다."),
        },
        GroupWords {
            word: "폴더",
            ungrouped: "폴더 없음",
            new_group: "새 폴더",
            create_group: "폴더 만들기",
            group_name: "폴더 이름",
            rename_group: "폴더 이름 변경",
            ungroup: "폴더 해제",
            move_to: "폴더로 이동",
            ungroup_title: |name| format!("‘{name}’ 폴더를 해제할까요?"),
            ungroup_body: |count| format!("북마크 {count}개는 그대로 남습니다."),
        },
    ],
    lang: Lang::Ko,
};

fn plural(count: i64) -> &'static str {
    if count == 1 { "" } else { "s" }
}

static EN: Words = Words {
    name: "Name",
    tags: "Tags",
    add_tag: "Add tag",
    create_tag: |name| format!("Create tag “{name}”"),
    remove_tag: |name| format!("Remove {name}"),
    manage_tags: "Manage tags…",
    no_tags: "No tags",
    merge: "Merge",
    merge_note: |from, from_count, to, to_count| {
        format!("Merges “{from}” ({from_count}) into “{to}” ({to_count}).")
    },
    delete_tag: "Delete tag",
    rename: "Rename",
    group_exists: "That name is taken.",
    failed: "Could not load the library",
    cancel: "Cancel",
    create: "Create",
    save: "Save",
    move_items: "Move",
    delete_item: "Delete",
    source: "Source",
    saved: "Saved",
    size: "Size",
    undo: "Undo",
    added: |count, group| format!("Added {count} to “{group}”"),
    saved_scraps: |count| format!("Saved {count} scrap{}", plural(count)),
    add_to_group: "Add to group",
    leave_ungrouped: "Leave ungrouped",
    mixed_kinds: "Items of different kinds can't move together.",
    tags_on_some: |count, total| format!("{count} of {total}"),
    add_to_all: "Add to all",
    remove_from_all: "Remove from all",
    bulk_tags_title: |count| format!("Tags · {count} items"),
    delete_selected: |count| format!("Delete {count} item{}?", plural(count)),
    delete_selected_body: "Deleted items can't be restored.",
    more: "More",
    browser_failed: "Could not open page",
    attach_to_chat: "Add to chat",
    attach: "Attach to chat",
    open_source_page: "Open source page",
    empty_library: "No items",
    site_labels: ["Output", "Document", "Bookmarks"],
    open_origin_chat: "Open origin chat",
    search: "Search",
    general: "Chats",
    artifact_loading: "Loading artifact",
    revision: "Version",
    authors: ["Me", "Butler"],
    groups: [
        GroupWords {
            word: "group",
            ungrouped: "Ungrouped",
            new_group: "New group",
            create_group: "Create group",
            group_name: "Group name",
            rename_group: "Rename group",
            ungroup: "Ungroup",
            move_to: "Move to group",
            ungroup_title: |name| format!("Ungroup “{name}”?"),
            ungroup_body: |count| format!("Its {count} scrap{} stay.", plural(count)),
        },
        GroupWords {
            word: "folder",
            ungrouped: "No folder",
            new_group: "New folder",
            create_group: "Create folder",
            group_name: "Folder name",
            rename_group: "Rename folder",
            ungroup: "Remove folder",
            move_to: "Move to folder",
            ungroup_title: |name| format!("Remove folder “{name}”?"),
            ungroup_body: |count| format!("Its {count} bookmark{} stay.", plural(count)),
        },
    ],
    lang: Lang::En,
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
