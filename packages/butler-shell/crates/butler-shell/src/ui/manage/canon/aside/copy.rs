//! The epic aside's copy. Each field names its `packages/butler-i18n` key (`canon.*` unless noted).
use butler_ds::ui::context::Lang;

use crate::ui::source::wire::CanonStatus;

pub(super) struct Words {
    /// canon.epic
    pub(super) epic: &'static str,
    /// canon.close
    pub(super) close: &'static str,
    /// canon.status
    pub(super) status: &'static str,
    /// canon.assignee
    pub(super) assignee: &'static str,
    /// canon.plan
    pub(super) plan: &'static str,
    /// canon.backlog
    pub(super) backlog: &'static str,
    /// canon.tags.label
    pub(super) tags: &'static str,
    /// canon.running
    pub(super) running: &'static str,
    /// canon.runningCancel
    pub(super) running_cancel: &'static str,
    /// canon.statusChanged
    pub(super) status_changed: &'static str,
    /// canon.conflict
    pub(super) conflict: &'static str,
    /// canon.openConversation
    pub(super) open_conversation: &'static str,
    /// canon.specs
    pub(super) specs: &'static str,
    /// canon.noSpecs
    pub(super) no_specs: &'static str,
    /// canon.title
    pub(super) title: &'static str,
    /// canon.description
    pub(super) description: &'static str,
    /// canon.noDescription
    pub(super) no_description: &'static str,
    /// canon.descriptionPlaceholder
    pub(super) description_placeholder: &'static str,
    /// canon.cancel
    pub(super) cancel: &'static str,
    /// canon.save
    pub(super) save: &'static str,
    /// canon.attachFile
    pub(super) attach_file: &'static str,
    /// canon.fileTooLarge
    pub(super) file_too_large: &'static str,
    /// canon.saving
    pub(super) saving: &'static str,
    /// canon.uploadingFile
    pub(super) uploading_file: &'static str,
    /// canon.inlineEdit.title
    pub(super) edit_title: &'static str,
    /// canon.inlineEdit.description
    pub(super) edit_description: &'static str,
    /// canon.inlineEdit.unsaved
    pub(super) unsaved: &'static str,
    /// canon.inlineEdit.keep
    pub(super) keep: &'static str,
    /// canon.inlineEdit.discard
    pub(super) discard: &'static str,
    /// canon.inlineEdit.saved
    pub(super) saved: &'static str,
    /// canon.inlineEdit.current
    pub(super) current: &'static str,
    /// canon.mcp.activity
    pub(super) activity: &'static str,
    /// canon.mcp.noActivity
    pub(super) no_activity: &'static str,
    /// canon.mcp.more
    pub(super) more: &'static str,
    /// canon.mcp.proposal
    pub(super) proposal: &'static str,
    /// canon.mcp.apply
    pub(super) apply: &'static str,
    /// canon.mcp.deny
    pub(super) deny: &'static str,
    /// canon.mcp.createdActivity
    pub(super) created_activity: &'static str,
    /// canon.mcp.editedActivity
    pub(super) edited_activity: &'static str,
    /// canon.mcp.appliedActivity
    pub(super) applied_activity: &'static str,
    /// canon.mcp.declinedActivity
    pub(super) declined_activity: &'static str,
    /// canon.deletion.action
    pub(super) delete: &'static str,
    /// canon.deletion.detail
    pub(super) delete_detail: &'static str,
    /// canon.deletion.running
    pub(super) delete_running: &'static str,
    /// canon.deletion.deleted
    pub(super) deleted: &'static str,
    /// canon.deletion.missing
    pub(super) missing: &'static str,
    /// interfaceFeedback.requestFailed
    pub(super) request_failed: &'static str,
    /// interfaceFeedback.uploadFailed
    pub(super) upload_failed: &'static str,
    /// feedback.retry
    pub(super) retry: &'static str,
    /// feedback.dashboardLoading
    pub(super) loading: &'static str,
    /// sessionInfo.work
    pub(super) work: &'static str,
    /// canon.statuses, in the order of the status select
    statuses: [&'static str; 6],
    /// canon.actionStatuses.active
    pub(super) action_active: &'static str,
    /// canon.moved
    pub(super) moved: fn(&str) -> String,
    /// canon.ordinal
    pub(super) ordinal: fn(usize) -> String,
    /// canon.done
    pub(super) done: fn(i64, i64) -> String,
    /// canon.mcp.working
    pub(super) working: fn(&str, &str) -> String,
    /// canon.criterionState
    pub(super) criterion_state: fn(&str, bool) -> String,
    /// canon.criterionActivity
    pub(super) criterion_activity: fn(&str, bool) -> String,
    /// canon.deletion.title
    pub(super) delete_title: fn(&str) -> String,
    /// space.rowMenu
    pub(super) row_menu: fn(&str) -> String,
    /// The `Intl.RelativeTimeFormat` words of an activity row.
    pub(super) time: Time,
}

/// `Intl.RelativeTimeFormat(locale, { numeric: "auto" })` for seconds, minutes, hours and days.
pub(super) struct Time {
    pub(super) now: &'static str,
    pub(super) yesterday: &'static str,
    pub(super) tomorrow: &'static str,
    /// The unit name, singular and plural, and where the number goes.
    pub(super) format: fn(i64, Unit) -> String,
}

#[derive(Clone, Copy)]
pub(super) enum Unit {
    Second,
    Minute,
    Hour,
    Day,
}

/// The order of the status select (`Object.entries(copy.statuses)`).
pub(super) const STATUSES: [CanonStatus; 6] = [
    CanonStatus::Planned,
    CanonStatus::InProgress,
    CanonStatus::InReview,
    CanonStatus::Blocked,
    CanonStatus::Done,
    CanonStatus::Cancelled,
];

impl Words {
    pub(super) fn status(&self, status: CanonStatus) -> &'static str {
        STATUSES
            .iter()
            .position(|known| *known == status)
            .map_or("", |index| self.statuses[index])
    }
}

fn ko_time(count: i64, unit: Unit) -> String {
    let (n, name) = (
        count.abs(),
        match unit {
            Unit::Second => "초",
            Unit::Minute => "분",
            Unit::Hour => "시간",
            Unit::Day => "일",
        },
    );
    format!("{n}{name} {}", if count < 0 { "전" } else { "후" })
}

fn en_time(count: i64, unit: Unit) -> String {
    let n = count.abs();
    let name = match unit {
        Unit::Second => "second",
        Unit::Minute => "minute",
        Unit::Hour => "hour",
        Unit::Day => "day",
    };
    let plural = if n == 1 { "" } else { "s" };
    if count < 0 {
        format!("{n} {name}{plural} ago")
    } else {
        format!("in {n} {name}{plural}")
    }
}

static KO: Words = Words {
    epic: "과제",
    close: "닫기",
    status: "상태",
    assignee: "담당",
    plan: "계획",
    backlog: "백로그",
    tags: "태그",
    running: "진행 중에는 완료할 수 없습니다",
    running_cancel: "진행 중에는 취소할 수 없습니다",
    status_changed: "상태를 바꿨습니다",
    conflict: "다른 사람이 먼저 고쳤습니다",
    open_conversation: "대화 열기",
    specs: "명세",
    no_specs: "아직 명세가 없습니다",
    title: "제목",
    description: "설명",
    no_description: "설명 없음",
    description_placeholder: "재현 방법, 기대 결과",
    cancel: "취소",
    save: "저장",
    attach_file: "파일 첨부",
    file_too_large: "10MB 이하만 첨부할 수 있습니다",
    saving: "저장 중",
    uploading_file: "업로드 중",
    edit_title: "제목 수정",
    edit_description: "설명 편집",
    unsaved: "변경 내용을 저장할까요?",
    keep: "계속 편집",
    discard: "저장 안 함",
    saved: "저장했습니다",
    current: "현재 값",
    activity: "활동",
    no_activity: "아직 활동이 없습니다",
    more: "더 보기",
    proposal: "명세 변경 제안",
    apply: "반영",
    deny: "거절",
    created_activity: "과제를 만들었습니다",
    edited_activity: "과제를 고쳤습니다",
    applied_activity: "명세 변경 반영",
    declined_activity: "명세 변경 거절",
    delete: "과제 삭제",
    delete_detail: "이 기기에서 삭제합니다. 연결된 대화는 남습니다.",
    delete_running: "진행 중에는 삭제할 수 없습니다",
    deleted: "과제를 삭제했습니다",
    missing: "이미 삭제된 과제입니다",
    request_failed: "요청을 처리하지 못했습니다.",
    upload_failed: "파일 업로드 실패",
    retry: "다시 시도",
    loading: "프로젝트 정보를 불러오는 중입니다.",
    work: "작업",
    statuses: ["예정", "진행 중", "검토 중", "막힘", "완료", "취소됨"],
    action_active: "진행 중",
    moved: |plan| format!("{plan}에 넣었습니다"),
    ordinal: |n| format!("{n}번째"),
    done: |done, total| format!("{done}/{total} 완료"),
    working: |person, via| format!("{person} · {via} 작업 중"),
    criterion_state: |id, confirmed| {
        format!("{id} {}", if confirmed { "확인됨" } else { "미확인" })
    },
    criterion_activity: |id, confirmed| {
        format!("{id} {}", if confirmed { "확인" } else { "확인 취소" })
    },
    delete_title: |title| format!("‘{title}’ 과제 삭제"),
    row_menu: |title| format!("{title} 메뉴"),
    time: Time {
        now: "지금",
        yesterday: "어제",
        tomorrow: "내일",
        format: ko_time,
    },
};

static EN: Words = Words {
    epic: "Epic",
    close: "Close",
    status: "Status",
    assignee: "Assignee",
    plan: "Plan",
    backlog: "Backlog",
    tags: "Tags",
    running: "Cannot complete while running",
    running_cancel: "Cannot cancel while running",
    status_changed: "Status changed",
    conflict: "Someone else edited this first",
    open_conversation: "Open conversation",
    specs: "Specs",
    no_specs: "No Specs yet",
    title: "Title",
    description: "Description",
    no_description: "No description",
    description_placeholder: "Steps to reproduce, expected result",
    cancel: "Cancel",
    save: "Save",
    attach_file: "Attach file",
    file_too_large: "Files up to 10 MB",
    saving: "Saving",
    uploading_file: "Uploading",
    edit_title: "Edit title",
    edit_description: "Edit description",
    unsaved: "Save changes?",
    keep: "Keep editing",
    discard: "Discard",
    saved: "Saved",
    current: "Current value",
    activity: "Activity",
    no_activity: "No activity yet",
    more: "More",
    proposal: "Spec change proposal",
    apply: "Apply",
    deny: "Deny",
    created_activity: "Epic created",
    edited_activity: "Epic edited",
    applied_activity: "Spec change applied",
    declined_activity: "Spec change declined",
    delete: "Delete Epic",
    delete_detail: "Delete locally. Linked conversations stay.",
    delete_running: "Cannot delete while running",
    deleted: "Epic deleted",
    missing: "Epic already deleted",
    request_failed: "Request failed.",
    upload_failed: "File upload failed.",
    retry: "Try again",
    loading: "Loading project information…",
    work: "Tasks",
    statuses: [
        "Planned",
        "In progress",
        "In review",
        "Blocked",
        "Done",
        "Cancelled",
    ],
    action_active: "In progress",
    moved: |plan| format!("Moved to {plan}"),
    ordinal: |n| format!("No. {n}"),
    done: |done, total| format!("{done}/{total} done"),
    working: |person, via| format!("{person} · {via} working"),
    criterion_state: |id, confirmed| {
        format!(
            "{id} {}",
            if confirmed {
                "confirmed"
            } else {
                "not confirmed"
            }
        )
    },
    criterion_activity: |id, confirmed| {
        format!(
            "{id} {}",
            if confirmed {
                "confirmed"
            } else {
                "unconfirmed"
            }
        )
    },
    delete_title: |title| format!("Delete Epic ‘{title}’"),
    row_menu: |title| format!("{title} menu"),
    time: Time {
        now: "now",
        yesterday: "yesterday",
        tomorrow: "tomorrow",
        format: en_time,
    },
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
