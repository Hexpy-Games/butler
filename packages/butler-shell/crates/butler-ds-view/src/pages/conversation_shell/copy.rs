//! The copy of the ConversationShell showcase (English and Korean).
use crate::copy::Lang;

pub(super) struct Copy {
    pub(super) turns: [(bool, &'static str); 6],
    pub(super) latest: &'static str,
    pub(super) unread: &'static str,
    pub(super) label: &'static str,
    pub(super) prompt: &'static str,
    pub(super) chat: [(bool, &'static str); 2],
    pub(super) title: &'static str,
    pub(super) suggestions: [(&'static str, &'static str); 2],
    pub(super) reply: &'static str,
}

pub(super) fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            turns: [
                (true, "Can you check why the settings page feels flat?"),
                (false, "The section description is the same size as the field labels and sits as close to the first field as fields sit to each other, so the page reads as one long list."),
                (true, "What would you change first?"),
                (false, "Give each section header its own block: a 13px secondary description with a limited measure, closed by a hairline before the first field."),
                (true, "Do it, and keep the field spacing as it is."),
                (false, "Done. The header block now ends with a divider and the type ramp reads title, label, description."),
            ],
            latest: "Jump to latest",
            unread: "New messages",
            label: "Session details",
            prompt: "Ask about this task",
            chat: [
                (true, "Draft the preview 14 release notes too."),
                (false, "The draft is in docs/release/preview-14.md. Commit it when you have read it."),
            ],
            title: "Where should we start today?",
            suggestions: [("Plan today", "Order open work into steps."), ("Review risky changes", "Find missed checks in recent work.")],
            reply: "Here is today's order: finish the review, then the release notes.",
        },
        Copy {
            turns: [
                (true, "설정 화면이 왜 밋밋해 보이는지 봐 줄래?"),
                (false, "섹션 설명이 필드 이름과 같은 크기이고 첫 필드와의 간격도 필드 사이 간격과 같아서, 페이지 전체가 긴 목록처럼 읽힙니다."),
                (true, "먼저 무엇을 바꾸면 좋을까?"),
                (false, "섹션 머리를 하나의 블록으로 만들겠습니다. 설명은 13px 보조 색으로 줄 길이를 제한하고, 첫 필드 앞에 가는 구분선을 둡니다."),
                (true, "그렇게 해 줘. 필드 간격은 그대로 두고."),
                (false, "적용했습니다. 이제 섹션 머리는 구분선으로 끝나고, 글자 위계는 제목, 이름, 설명 순으로 읽힙니다."),
            ],
            latest: "최신으로 이동",
            unread: "새 메시지",
            label: "세션 정보",
            prompt: "이 과제에 대해 말해 보세요",
            chat: [
                (true, "릴리스 노트 초안도 만들어줘."),
                (false, "프리뷰 14 릴리스 노트 초안을 docs/release/preview-14.md에 만들었습니다. 읽어 보시고 커밋해 주세요."),
            ],
            title: "오늘은 어디서 시작할까요",
            suggestions: [("오늘 순서 세우기", "열린 일을 실행 순서로 정리합니다."), ("위험한 변경 보기", "최근 작업에서 빠진 검증을 찾습니다.")],
            reply: "오늘 순서입니다. 리뷰를 마치고 릴리스 노트를 씁니다.",
        },
    )
}
