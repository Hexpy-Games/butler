//! The copy of the plan overview and its dialogs. Each field names its `packages/butler-i18n`
//! key (`locales/canon.ts` `canon.*` unless it names another).
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// canon.plan
    pub(super) plan: &'static str,
    /// canon.noPlan
    pub(super) no_plan: &'static str,
    /// canon.backlog
    pub(super) backlog: &'static str,
    /// canon.editPlan
    pub(super) edit_plan: &'static str,
    /// canon.newEpic
    pub(super) new_epic: &'static str,
    /// canon.newPlan
    pub(super) new_plan: &'static str,
    /// canon.edit
    pub(super) edit: &'static str,
    /// canon.create
    pub(super) create: &'static str,
    /// canon.save
    pub(super) save: &'static str,
    /// canon.dueOn
    pub(super) due_on: &'static str,
    /// canon.optional
    pub(super) optional: &'static str,
    /// canon.assignee
    pub(super) assignee: &'static str,
    /// canon.progress
    pub(super) progress: &'static str,
    /// canon.done
    pub(super) done: fn(usize, usize) -> String,
    /// canon.due
    pub(super) due: fn(&str) -> String,
    /// canon.planMissing
    pub(super) plan_missing: &'static str,
    /// canon.epicCount
    pub(super) epic_count: fn(usize) -> String,
    /// canon.sharedOrder
    pub(super) shared_order: &'static str,
    /// canon.backlogOrderHelp
    pub(super) backlog_order_help: &'static str,
    /// canon.noEpics
    pub(super) no_epics: &'static str,
    /// canon.noDescription
    pub(super) no_description: &'static str,
    /// canon.reordered
    pub(super) reordered: &'static str,
    /// canon.conflict
    pub(super) conflict: &'static str,
    /// canon.created
    pub(super) created: &'static str,
    /// canon.statuses.{planned,in_progress,in_review,blocked,done,cancelled}
    pub(super) statuses: [&'static str; 6],
    /// canon.criteriaCount
    pub(super) criteria_count: fn(i64, i64) -> String,
    /// interfaceFeedback.requestFailed
    pub(super) request_failed: &'static str,
    /// feedback.retry
    pub(super) retry: &'static str,
    /// feedback.dashboardLoading
    pub(super) loading: &'static str,
    /// canon.mcp.trustTitle
    pub(super) trust_title: fn(&str) -> String,
    /// canon.mcp.trustDescription
    pub(super) trust_description: &'static str,
    /// canon.mcp.client
    pub(super) client: &'static str,
    /// canon.mcp.person
    pub(super) person: &'static str,
    /// canon.mcp.requestedPermissions
    pub(super) requested: &'static str,
    /// canon.mcp.trustNotice
    pub(super) trust_notice: fn(&str) -> String,
    /// canon.mcp.capabilities
    pub(super) capabilities: [(&'static str, &'static str); 9],
    /// canon.mcp.allow
    pub(super) allow: &'static str,
    /// canon.mcp.deny
    pub(super) deny: &'static str,
    /// canon.statusChanged
    pub(super) status_changed: &'static str,
    /// canon.openConversation
    pub(super) open_conversation: &'static str,
    /// canon.changePlan
    pub(super) change_plan: &'static str,
    /// canon.moved
    pub(super) moved: fn(&str) -> String,
    /// space.rowMenu
    pub(super) row_menu: fn(&str) -> String,
    /// canon.cancel
    pub(super) cancel: &'static str,
    /// canon.deletion.action
    pub(super) delete: &'static str,
    /// canon.deletion.title
    pub(super) delete_title: fn(&str) -> String,
    /// canon.deletion.detail
    pub(super) delete_detail: &'static str,
    /// canon.deletion.running
    pub(super) delete_running: &'static str,
    /// canon.deletion.deleted
    pub(super) deleted: &'static str,
    months: [&'static str; 12],
}

static KO: Words = Words {
    plan: "계획",
    no_plan: "계획 없음",
    backlog: "백로그",
    edit_plan: "계획 고치기",
    new_epic: "새 과제",
    new_plan: "새 계획",
    edit: "고치기",
    create: "만들기",
    save: "저장",
    due_on: "마감일",
    optional: "선택",
    assignee: "담당",
    progress: "진행",
    done: |done, total| format!("{done}/{total} 완료"),
    due: |date| format!("{date}까지"),
    plan_missing: "계획을 찾을 수 없습니다",
    epic_count: |n| format!("과제 · {n}"),
    shared_order: "기준 순서 · 끌어서 바꾸기",
    backlog_order_help: "계획으로 옮기려면 ⋯ 메뉴",
    no_epics: "아직 과제가 없습니다",
    no_description: "설명 없음",
    reordered: "과제 순서를 바꿨습니다",
    conflict: "다른 사람이 먼저 고쳤습니다",
    created: "과제를 만들었습니다",
    statuses: ["예정", "진행 중", "검토 중", "막힘", "완료", "취소됨"],
    criteria_count: |confirmed, total| format!("{confirmed}/{total} 확인"),
    request_failed: "요청을 처리하지 못했습니다.",
    retry: "다시 시도",
    loading: "프로젝트 정보를 불러오는 중입니다.",
    trust_title: |client| format!("{client}에 캐논 권한을 줄까요?"),
    trust_description: "요청한 권한을 확인하세요",
    client: "연결 대상",
    person: "대리하는 사람",
    requested: "요청한 권한",
    trust_notice: |person| {
        format!("이 도구는 {person} 님 권한으로 일합니다. 작업 내부 기록과 대화는 볼 수 없습니다.")
    },
    capabilities: [
        ("canon.read", "계획·과제·명세 읽기"),
        ("canon.epic.status", "과제 상태 바꾸기"),
        ("canon.epic.comment", "과제에 댓글 달기"),
        ("canon.epic.create", "과제 만들기"),
        ("canon.plan.create", "계획 만들기"),
        ("canon.epic.edit", "과제 내용·태그 고치기, 옮기기"),
        ("canon.plan.edit", "계획 고치기"),
        ("canon.tag.create", "태그 만들기"),
        ("canon.spec.propose", "명세 변경 제안"),
    ],
    allow: "허용",
    deny: "거절",
    status_changed: "상태를 바꿨습니다",
    open_conversation: "대화 열기",
    change_plan: "계획 바꾸기",
    moved: |plan| format!("{plan}에 넣었습니다"),
    row_menu: |title| format!("{title} 메뉴"),
    cancel: "취소",
    delete: "과제 삭제",
    delete_title: |title| format!("‘{title}’ 과제 삭제"),
    delete_detail: "이 기기에서 삭제합니다. 연결된 대화는 남습니다.",
    delete_running: "진행 중에는 삭제할 수 없습니다",
    deleted: "과제를 삭제했습니다",
    months: [
        "1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월",
    ],
};

static EN: Words = Words {
    plan: "Plan",
    no_plan: "No Plan",
    backlog: "Backlog",
    edit_plan: "Edit plan",
    new_epic: "New Epic",
    new_plan: "New Plan",
    edit: "Edit",
    create: "Create",
    save: "Save",
    due_on: "Due date",
    optional: "Optional",
    assignee: "Assignee",
    progress: "Progress",
    done: |done, total| format!("{done}/{total} done"),
    due: |date| format!("Due {date}"),
    plan_missing: "Plan not found",
    epic_count: |n| format!("Epics · {n}"),
    shared_order: "Shared order · Drag to reorder",
    backlog_order_help: "Use the ⋯ menu to move to a Plan",
    no_epics: "No Epics yet",
    no_description: "No description",
    reordered: "Epic order changed",
    conflict: "Someone else edited this first",
    created: "Epic created",
    statuses: [
        "Planned",
        "In progress",
        "In review",
        "Blocked",
        "Done",
        "Cancelled",
    ],
    criteria_count: |confirmed, total| format!("{confirmed}/{total} confirmed"),
    request_failed: "Request failed.",
    retry: "Try again",
    loading: "Loading project information…",
    trust_title: |client| format!("Give {client} canon access?"),
    trust_description: "Review requested access",
    client: "Connected tool",
    person: "Acting for",
    requested: "Requested permissions",
    trust_notice: |person| {
        format!(
            "This tool acts for {person}. Internal task records and conversations stay private."
        )
    },
    capabilities: [
        ("canon.read", "Read Plans, Epics and Specs"),
        ("canon.epic.status", "Change Epic status"),
        ("canon.epic.comment", "Comment on Epics"),
        ("canon.epic.create", "Create Epics"),
        ("canon.plan.create", "Create Plans"),
        ("canon.epic.edit", "Edit, tag and move Epics"),
        ("canon.plan.edit", "Edit Plans"),
        ("canon.tag.create", "Create Tags"),
        ("canon.spec.propose", "Propose Spec changes"),
    ],
    allow: "Allow",
    deny: "Deny",
    status_changed: "Status changed",
    open_conversation: "Open conversation",
    change_plan: "Change Plan",
    moved: |plan| format!("Moved to {plan}"),
    row_menu: |title| format!("{title} menu"),
    cancel: "Cancel",
    delete: "Delete Epic",
    delete_title: |title| format!("Delete Epic ‘{title}’"),
    delete_detail: "Delete locally. Linked conversations stay.",
    delete_running: "Cannot delete while running",
    deleted: "Epic deleted",
    months: [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ],
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

impl Words {
    /// `Intl.DateTimeFormat(locale, { month: "long", day: "numeric" })` of a `YYYY-MM-DD` date.
    pub(super) fn day(&self, date: &str, lang: Lang) -> Option<String> {
        let mut parts = date.split('-').skip(1);
        let month = parts.next()?.parse::<usize>().ok()?;
        let day = parts.next()?.parse::<u32>().ok()?;
        let name = self.months.get(month.checked_sub(1)?)?;
        Some(match lang {
            Lang::Ko => format!("{name} {day}일"),
            Lang::En => format!("{name} {day}"),
        })
    }

    /// `canon.statuses[status]`
    pub(super) fn status(&self, status: crate::ui::source::wire::CanonStatus) -> &'static str {
        use crate::ui::source::wire::CanonStatus as S;
        match status {
            S::Planned | S::Unknown => self.statuses[0],
            S::InProgress => self.statuses[1],
            S::InReview => self.statuses[2],
            S::Blocked => self.statuses[3],
            S::Done => self.statuses[4],
            S::Cancelled => self.statuses[5],
        }
    }
}
