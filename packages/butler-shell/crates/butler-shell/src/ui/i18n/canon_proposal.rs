//! The copy of the canon proposal card (`canonProposalCopy.ts`, `CanonProposalChanges`). Each
//! field names its `packages/butler-i18n` key or the React literal.
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

pub(crate) struct CanonProposalCopy {
    /// canon.deletion: addDelete, changeDelete, changed, action, deleted, detail
    pub(crate) add_delete: &'static str,
    pub(crate) change_delete: &'static str,
    pub(crate) changed: &'static str,
    pub(crate) delete_epic: &'static str,
    pub(crate) deleted: &'static str,
    pub(crate) delete_detail: &'static str,
    /// canon.deletion.missing, canon.conflict, interfaceFeedback.requestFailed
    pub(crate) missing: &'static str,
    pub(crate) conflict: &'static str,
    pub(crate) request_failed: &'static str,
    /// canonProposalCopy
    pub(crate) draft: &'static str,
    pub(crate) changes: &'static str,
    pub(crate) cancel: &'static str,
    pub(crate) add: &'static str,
    pub(crate) apply: &'static str,
    pub(crate) added: &'static str,
    pub(crate) chat: &'static str,
    pub(crate) cancelled: &'static str,
    pub(crate) superseded: &'static str,
    pub(crate) stale: &'static str,
    pub(crate) record: &'static str,
    pub(crate) name: &'static str,
    pub(crate) current_plan: &'static str,
    pub(crate) project: &'static str,
    pub(crate) new_project: &'static str,
    /// CanonProposalChanges labels
    pub(crate) edit_epic: &'static str,
    pub(crate) add_plan: &'static str,
    pub(crate) edit_plan: &'static str,
    pub(crate) reorder: &'static str,
    pub(crate) edit_spec: &'static str,
    pub(crate) destination_plan: &'static str,
    pub(crate) backlog: &'static str,
    pub(crate) order: &'static str,
    pub(crate) closed: &'static str,
    pub(crate) open: &'static str,
    /// canon: status, assignee, dueOn, me, none
    pub(crate) status: &'static str,
    pub(crate) assignee: &'static str,
    pub(crate) due_on: &'static str,
    pub(crate) me: &'static str,
    pub(crate) none: &'static str,
    /// canon.statuses
    pub(crate) planned: &'static str,
    pub(crate) in_progress: &'static str,
    pub(crate) in_review: &'static str,
    pub(crate) blocked: &'static str,
    pub(crate) done: &'static str,
    pub(crate) status_cancelled: &'static str,
}

const KO: CanonProposalCopy = CanonProposalCopy {
    add_delete: "과제 등록 및 삭제",
    change_delete: "과제 변경 및 삭제",
    changed: "과제 변경을 반영했습니다",
    delete_epic: "과제 삭제",
    deleted: "과제를 삭제했습니다",
    delete_detail: "이 기기에서 삭제합니다. 연결된 대화는 남습니다.",
    missing: "이미 삭제된 과제입니다",
    conflict: "다른 사람이 먼저 고쳤습니다",
    request_failed: "요청을 처리하지 못했습니다.",
    draft: "과제 초안 · 버틀러",
    changes: "변경 제안 · 버틀러",
    cancel: "취소",
    add: "등록",
    apply: "반영",
    added: "등록함",
    chat: "대화로 등록함",
    cancelled: "취소함",
    superseded: "새 초안으로 바뀜",
    stale: "이전 내용 기준",
    record: "과제 등록함 · 버틀러",
    name: "이름을 입력하세요",
    current_plan: "현재 계획",
    project: "프로젝트",
    new_project: "새 프로젝트",
    edit_epic: "과제 변경",
    add_plan: "계획 등록",
    edit_plan: "계획 변경",
    reorder: "순서 변경",
    edit_spec: "명세 변경",
    destination_plan: "대상 계획",
    backlog: "백로그",
    order: "순서",
    closed: "닫힘",
    open: "열림",
    status: "상태",
    assignee: "담당",
    due_on: "마감일",
    me: "나",
    none: "없음",
    planned: "예정",
    in_progress: "진행 중",
    in_review: "검토 중",
    blocked: "막힘",
    done: "완료",
    status_cancelled: "취소됨",
};

const EN: CanonProposalCopy = CanonProposalCopy {
    add_delete: "Add and delete Epics",
    change_delete: "Change and delete Epics",
    changed: "Epic changes applied",
    delete_epic: "Delete Epic",
    deleted: "Epic deleted",
    delete_detail: "Delete locally. Linked conversations stay.",
    missing: "Epic already deleted",
    conflict: "Someone else edited this first",
    request_failed: "Request failed.",
    draft: "Epic draft · Butler",
    changes: "Changes · Butler",
    cancel: "Cancel",
    add: "Add",
    apply: "Apply",
    added: "Added",
    chat: "Added in chat",
    cancelled: "Cancelled",
    superseded: "Replaced",
    stale: "Out of date",
    record: "Epic added · Butler",
    name: "Enter a name",
    current_plan: "Current plan",
    project: "Project",
    new_project: "New project",
    edit_epic: "Edit Epic",
    add_plan: "Add plan",
    edit_plan: "Edit plan",
    reorder: "Reorder",
    edit_spec: "Edit spec",
    destination_plan: "Destination plan",
    backlog: "Backlog",
    order: "Order",
    closed: "Closed",
    open: "Open",
    status: "Status",
    assignee: "Assignee",
    due_on: "Due date",
    me: "Me",
    none: "None",
    planned: "Planned",
    in_progress: "In progress",
    in_review: "In review",
    blocked: "Blocked",
    done: "Done",
    status_cancelled: "Cancelled",
};

impl CanonProposalCopy {
    pub(crate) fn of(lang: Lang) -> &'static Self {
        match lang {
            Lang::Ko => &KO,
            Lang::En => &EN,
        }
    }

    pub(crate) fn get(cx: &App) -> &'static Self {
        Self::of(Ds::get(cx).lang())
    }

    /// canonProposalCopy.target: where the Epic goes.
    pub(crate) fn target(lang: Lang, plan: Option<&str>, name: Option<&str>) -> String {
        match (lang, name, plan) {
            (Lang::Ko, Some(name), _) => format!("새 프로젝트 ‘{name}’ 만들고 과제 등록"),
            (Lang::En, Some(name), _) => format!("Create project ‘{name}’ and add Epic"),
            (Lang::Ko, None, Some(plan)) => format!("‘{plan}’에 과제 등록"),
            (Lang::En, None, Some(plan)) => format!("Add Epic to ‘{plan}’"),
            (Lang::Ko, None, None) => "백로그에 과제 등록".to_owned(),
            (Lang::En, None, None) => "Add Epic to Backlog".to_owned(),
        }
    }
}
