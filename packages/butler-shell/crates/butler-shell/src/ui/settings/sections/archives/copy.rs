//! The copy of Archives. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(crate) struct Words {
    /// settings.pageSections.archived
    pub(crate) title: &'static str,
    /// interfaceDetails.archivesEmpty
    pub(crate) empty: &'static str,
    /// interfaceDetails.unarchive
    pub(crate) unarchive: &'static str,
    /// common.delete
    pub(crate) delete: &'static str,
    /// common.more
    pub(crate) more: &'static str,
    /// interfaceDetails.project
    pub(crate) project: &'static str,
    /// interfaceDetails.generalConversation
    pub(crate) general_conversation: &'static str,
    /// interfaceDetails.unknownProject
    pub(crate) unknown_project: &'static str,
    /// space.general
    pub(crate) space_general: &'static str,
    /// interfaceTemplates.projectConversation
    pub(crate) project_conversation: fn(&str) -> String,
    /// interfaceTemplates.deleteItem
    pub(crate) delete_item: fn(&str) -> String,
    /// settings.archiveErrors.remove
    pub(crate) remove_failed: &'static str,
    /// settings.archiveErrors.restore
    pub(crate) restore_failed: &'static str,
    /// settings.archiveErrors.loadMore
    pub(crate) load_more_failed: &'static str,
}

const KO: Words = Words {
    title: "보관된 항목",
    empty: "보관된 프로젝트나 대화가 없습니다.",
    unarchive: "아카이브 취소",
    delete: "삭제",
    more: "더보기",
    project: "프로젝트",
    general_conversation: "일반 대화",
    unknown_project: "알 수 없는 프로젝트",
    space_general: "대화",
    project_conversation: |title| format!("프로젝트 대화 · {title}"),
    delete_item: |title| format!("\"{title}\" 항목을 삭제할까요?"),
    remove_failed: "삭제하지 못했습니다.",
    restore_failed: "복원하지 못했습니다.",
    load_more_failed: "더 불러오지 못했습니다.",
};

const EN: Words = Words {
    title: "Archived items",
    empty: "No archived projects or conversations.",
    unarchive: "Unarchive",
    delete: "Delete",
    more: "More",
    project: "Project",
    general_conversation: "General conversation",
    unknown_project: "Unknown project",
    space_general: "Chats",
    project_conversation: |title| format!("Project conversation · {title}"),
    delete_item: |title| format!("Delete \"{title}\"?"),
    remove_failed: "Couldn't delete it.",
    restore_failed: "Couldn't restore it.",
    load_more_failed: "Couldn't load more.",
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
