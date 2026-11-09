//! The copy of the shared canon parts. Each field names its `packages/butler-i18n` key
//! (`locales/canon.ts`, `canon.` prefix left out unless it says otherwise).
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// me
    pub(super) me: &'static str,
    /// none
    pub(super) none: &'static str,
    /// plan
    pub(super) plan: &'static str,
    /// backlog
    pub(super) backlog: &'static str,
    /// assignee
    pub(super) assignee: &'static str,
    /// title
    pub(super) title: &'static str,
    /// titlePlaceholder
    pub(super) title_placeholder: &'static str,
    /// description
    pub(super) description: &'static str,
    /// descriptionPlaceholder
    pub(super) description_placeholder: &'static str,
    /// optional
    pub(super) optional: &'static str,
    /// cancel
    pub(super) cancel: &'static str,
    /// titleRequired
    pub(super) title_required: &'static str,
    /// save
    pub(super) save: &'static str,
    /// conflict
    pub(super) conflict: &'static str,
    /// interfaceFeedback.requestFailed (`en.ts` / `ko.ts`)
    pub(super) request_failed: &'static str,
    /// mcp.butler
    pub(super) mcp_butler: &'static str,
    /// criteriaCount(confirmed, total)
    pub(super) criteria_count: fn(i64, i64) -> String,
    /// personLabel(name, self)
    pub(super) person_label: fn(&str, bool) -> String,
    /// mcp.working(person, via)
    pub(super) mcp_working: fn(&str, &str) -> String,
    pub(super) tags: Tags,
}

/// `canon.tags`
pub(super) struct Tags {
    /// label
    pub(super) label: &'static str,
    /// add
    pub(super) add: &'static str,
    /// filter
    pub(super) filter: &'static str,
    /// searchPlaceholder
    pub(super) search_placeholder: &'static str,
    /// empty
    pub(super) empty: &'static str,
    /// clearAll
    pub(super) clear_all: &'static str,
    /// rename
    pub(super) rename: &'static str,
    /// recolor
    pub(super) recolor: &'static str,
    /// remove
    pub(super) remove: &'static str,
    /// name
    pub(super) name: &'static str,
    /// loading
    pub(super) loading: &'static str,
    /// colors: gray, red, orange, yellow, green, teal, blue, purple
    pub(super) colors: [&'static str; 8],
    /// create(name)
    pub(super) create: fn(&str) -> String,
    /// menu(name)
    pub(super) menu: fn(&str) -> String,
    /// removeTag(name)
    pub(super) remove_tag: fn(&str) -> String,
    /// deleteTitle(name)
    pub(super) delete_title: fn(&str) -> String,
    /// deleteDetail(count)
    pub(super) delete_detail: fn(usize) -> String,
}

static KO: Words = Words {
    me: "나",
    none: "없음",
    plan: "계획",
    backlog: "백로그",
    assignee: "담당",
    title: "제목",
    title_placeholder: "무엇을 할까요?",
    description: "설명",
    description_placeholder: "재현 방법, 기대 결과",
    optional: "선택",
    cancel: "취소",
    title_required: "제목을 입력하세요",
    save: "저장",
    conflict: "다른 사람이 먼저 고쳤습니다",
    request_failed: "요청을 처리하지 못했습니다.",
    mcp_butler: "버틀러",
    criteria_count: |confirmed, total| format!("{confirmed}/{total} 확인"),
    person_label: |name, own| {
        if own {
            "나".to_owned()
        } else {
            format!("{name} 님")
        }
    },
    mcp_working: |person, via| format!("{person} · {via} 작업 중"),
    tags: Tags {
        label: "태그",
        add: "태그 추가",
        filter: "태그 필터",
        search_placeholder: "태그 이름",
        empty: "태그 없음",
        clear_all: "모두 지우기",
        rename: "이름 바꾸기",
        recolor: "색 바꾸기",
        remove: "삭제",
        name: "태그 이름",
        loading: "불러오는 중",
        colors: [
            "회색", "빨강", "주황", "노랑", "초록", "청록", "파랑", "보라",
        ],
        create: |name| format!("‘{name}’ 만들기"),
        menu: |name| format!("{name} 태그 메뉴"),
        remove_tag: |name| format!("{name} 빼기"),
        delete_title: |name| format!("‘{name}’ 태그를 지울까요?"),
        delete_detail: |count| format!("과제 {count}개에서 빠집니다"),
    },
};

static EN: Words = Words {
    me: "Me",
    none: "None",
    plan: "Plan",
    backlog: "Backlog",
    assignee: "Assignee",
    title: "Title",
    title_placeholder: "What should we do?",
    description: "Description",
    description_placeholder: "Steps to reproduce, expected result",
    optional: "Optional",
    cancel: "Cancel",
    title_required: "Enter a title",
    save: "Save",
    conflict: "Someone else edited this first",
    request_failed: "Request failed.",
    mcp_butler: "Butler",
    criteria_count: |confirmed, total| format!("{confirmed}/{total} confirmed"),
    person_label: |name, own| {
        if own {
            "Me".to_owned()
        } else {
            name.to_owned()
        }
    },
    mcp_working: |person, via| format!("{person} · {via} working"),
    tags: Tags {
        label: "Tags",
        add: "Add tag",
        filter: "Tag filter",
        search_placeholder: "Tag name",
        empty: "No tags",
        clear_all: "Clear all",
        rename: "Rename",
        recolor: "Change color",
        remove: "Delete",
        name: "Tag name",
        loading: "Loading",
        colors: [
            "Gray", "Red", "Orange", "Yellow", "Green", "Teal", "Blue", "Purple",
        ],
        create: |name| format!("Create ‘{name}’"),
        menu: |name| format!("{name} tag menu"),
        remove_tag: |name| format!("Remove {name}"),
        delete_title: |name| format!("Delete the ‘{name}’ tag?"),
        delete_detail: |count| {
            if count == 1 {
                "It will be removed from 1 Epic".to_owned()
            } else {
                format!("It will be removed from {count} Epics")
            }
        },
    },
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
