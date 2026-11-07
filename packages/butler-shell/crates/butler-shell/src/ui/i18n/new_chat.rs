//! The new chat's copy: the fallback briefing shown until (or without) the server's, and the
//! epic caption. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

use crate::ui::source::wire::NewChatSuggestion;

pub(crate) struct Words {
    /// space.newChat
    pub(crate) new_chat: &'static str,
    /// canon.backlog
    pub(crate) backlog: &'static str,
}

static KO: Words = Words {
    new_chat: "새 대화",
    backlog: "백로그",
};

static EN: Words = Words {
    new_chat: "New chat",
    backlog: "Backlog",
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

fn suggestion(
    id: &str,
    title: impl Into<String>,
    description: impl Into<String>,
    text: impl Into<String>,
    template: bool,
) -> NewChatSuggestion {
    NewChatSuggestion {
        id: id.to_owned(),
        title: title.into(),
        description: description.into(),
        text: text.into(),
        template,
    }
}

/// briefing.general.suggestions
pub(crate) fn general_suggestions(lang: Lang) -> Vec<NewChatSuggestion> {
    match lang {
        Lang::Ko => vec![
            suggestion(
                "organize-download-folder",
                "다운로드 폴더 정리하기",
                "이 컴퓨터의 파일을 살펴보고 옮기기 전에 묻습니다.",
                "다운로드 폴더를 종류별로 정리해줘. 옮기기 전에 계획부터 보여줘.",
                false,
            ),
            suggestion(
                "summarize-document",
                "문서 요약하기",
                "첨부하거나 붙여 넣은 문서의 핵심을 정리합니다.",
                "이 내용을 핵심만 요약해줘: ",
                true,
            ),
            suggestion(
                "draft-reply",
                "답장 초안 쓰기",
                "짧은 메모를 바탕으로 답장 초안을 씁니다.",
                "이 메모로 답장 초안을 써줘: ",
                true,
            ),
            suggestion(
                "morning-briefing",
                "매일 아침 브리핑 받기",
                "날씨·뉴스·일정을 8시에 전하는 예약 작업을 만듭니다.",
                "매일 아침 8시에 날씨와 뉴스, 오늘 일정을 알려주는 예약 작업을 만들어줘.",
                false,
            ),
        ],
        Lang::En => vec![
            suggestion(
                "organize-download-folder",
                "Downloads folder cleanup",
                "Butler checks files on this computer and asks before moving them.",
                "Sort my Downloads folder by type. Show me the plan before moving anything.",
                false,
            ),
            suggestion(
                "summarize-document",
                "Document summary",
                "Attach or paste a document to get the key points.",
                "Summarize this in a few key points: ",
                true,
            ),
            suggestion(
                "draft-reply",
                "Reply draft",
                "Turn a short note into a clear reply.",
                "Draft a reply from this note: ",
                true,
            ),
            suggestion(
                "morning-briefing",
                "Morning briefing",
                "Create a daily 8 AM schedule for weather, news, and today's plans.",
                "Create a daily 8 AM schedule with weather, news, and today's plans.",
                false,
            ),
        ],
    }
}

/// briefing.projectSuggestions
pub(crate) fn project_suggestions(lang: Lang, name: &str) -> Vec<NewChatSuggestion> {
    match lang {
        Lang::Ko => vec![
            suggestion(
                "folder-tour",
                "폴더 둘러보기",
                format!("{name}에 무엇이 있는지 빠르게 살펴봅니다."),
                "이 프로젝트 폴더에 무엇이 있고 어떻게 구성되어 있는지 설명해줘.",
                false,
            ),
            suggestion(
                "organize-files",
                "파일 정리하기",
                "원하는 기준으로 파일을 나누거나 이름을 바꿉니다.",
                "이 폴더의 파일을 정리해줘: ",
                true,
            ),
            suggestion(
                "recent-changes",
                "최근 변경 보기",
                "최근에 무엇이 바뀌었는지 확인합니다.",
                format!("{name}에서 최근에 바뀐 내용을 알려줘."),
                false,
            ),
            suggestion(
                "remaining-work",
                "남은 일 보기",
                "아직 해야 할 일을 정리합니다.",
                format!("{name}에 남은 일을 정리해줘."),
                false,
            ),
            suggestion(
                "project-blockers",
                "막힌 곳 찾기",
                format!("{name}에서 진행이 멈춘 곳을 찾습니다."),
                format!("{name}에서 막힌 부분을 찾아줘."),
                false,
            ),
        ],
        Lang::En => vec![
            suggestion(
                "folder-tour",
                "What's in this folder",
                format!("Get a quick tour of {name}."),
                "Explain what's in this project folder and how it's organized.",
                false,
            ),
            suggestion(
                "organize-files",
                "Organize files",
                "Sort or rename files using criteria you choose.",
                "Organize the files in this folder: ",
                true,
            ),
            suggestion(
                "recent-changes",
                "What changed",
                "See what changed here recently.",
                format!("Tell me what changed in {name} recently."),
                false,
            ),
            suggestion(
                "remaining-work",
                "What's left",
                "List what still needs doing.",
                format!("What's left to do in {name}?"),
                false,
            ),
            suggestion(
                "project-blockers",
                "What's stuck",
                format!("Find where {name} is stuck."),
                format!("Find what's stuck in {name}."),
                false,
            ),
        ],
    }
}

/// canon.epicCaption
pub(crate) fn epic_caption(lang: Lang, group: &str) -> String {
    match lang {
        Lang::Ko => format!("{group} · 과제"),
        Lang::En => format!("{group} · Epic"),
    }
}
