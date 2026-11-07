//! The attachment tiles, the "+" menu, the project document picker and the upload toasts.
use butler_ds::ui::context::Lang;

pub(crate) struct AttachCopy {
    /// attachmentExtension fallback
    pub(crate) file: &'static str,
    pub(crate) attached_files: &'static str,
    pub(crate) more_options: &'static str,
    pub(crate) attachments: &'static str,
    pub(crate) attach_file: &'static str,
    pub(crate) attach_image: &'static str,
    pub(crate) normal: &'static str,
    pub(crate) response_mode: &'static str,
    pub(crate) plan: &'static str,
    pub(crate) project_documents: &'static str,
    pub(crate) search_documents: &'static str,
    pub(crate) no_documents: &'static str,
    pub(crate) documents_failed: &'static str,
    /// projectDocumentGroups titles
    pub(crate) all: &'static str,
    pub(crate) spec: &'static str,
    pub(crate) roadmap: &'static str,
    pub(crate) work: &'static str,
    pub(crate) report: &'static str,
    pub(crate) task: &'static str,
    /// Toasts: connection failure, empty file (names), oversized (names, limit), remove (name).
    pub(crate) upload_failed: fn(&str) -> String,
    pub(crate) upload_empty: fn(&str) -> String,
    pub(crate) upload_oversized: fn(&str, &str) -> String,
    pub(crate) remove: fn(&str) -> String,
}

const EN: AttachCopy = AttachCopy {
    file: "File",
    attached_files: "Attached files",
    more_options: "More options",
    attachments: "Attachments",
    attach_file: "Attach file",
    attach_image: "Attach image",
    normal: "Normal",
    response_mode: "Response mode",
    plan: "Plan",
    project_documents: "Project documents",
    search_documents: "Search document titles",
    no_documents: "No project documents.",
    documents_failed: "Project documents failed",
    all: "All",
    spec: "Spec",
    roadmap: "Roadmap",
    work: "Work",
    report: "Report",
    task: "Task",
    upload_failed: |names| format!("{names} — Check your connection, then select the file again."),
    upload_empty: |names| format!("{names} — File is empty."),
    upload_oversized: |names, limit| {
        format!("{names} — Reduce each file to {limit} or less, or select another file.")
    },
    remove: |name| format!("Remove {name}"),
};

const KO: AttachCopy = AttachCopy {
    file: "파일",
    attached_files: "첨부 파일",
    more_options: "추가 기능",
    attachments: "첨부",
    attach_file: "파일 첨부",
    attach_image: "이미지 첨부",
    normal: "일반",
    response_mode: "응답 방식",
    plan: "계획",
    project_documents: "프로젝트 문서",
    search_documents: "문서 제목 검색",
    no_documents: "프로젝트 문서가 없습니다.",
    documents_failed: "프로젝트 문서를 불러오지 못했습니다",
    all: "전체",
    spec: "스펙",
    roadmap: "로드맵",
    work: "작업",
    report: "보고서",
    task: "하위 작업",
    upload_failed: |names| format!("{names} — 연결을 확인한 뒤 파일을 다시 선택해 주세요."),
    upload_empty: |names| format!("{names} — 빈 파일입니다."),
    upload_oversized: |names, limit| {
        format!("{names} — 파일당 {limit} 이하로 줄이거나 다른 파일을 선택해 주세요.")
    },
    remove: |name| format!("{name} 제거"),
};

pub(crate) fn copy(lang: Lang) -> &'static AttachCopy {
    if lang == Lang::Ko { &KO } else { &EN }
}
