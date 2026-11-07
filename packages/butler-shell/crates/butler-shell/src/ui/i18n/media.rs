//! The copy of the transcript's media and async leaves: message Markdown, files, the image
//! viewer, the queue and the answer blocks. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

pub(crate) struct Media {
    /// conversation.markdown.copyCode, copied
    pub(crate) copy_code: &'static str,
    pub(crate) copied: &'static str,
    /// conversation.artifacts: save, saved, saveFailed, viewWork, file, open, more
    pub(crate) save: &'static str,
    pub(crate) artifact_saved: &'static str,
    pub(crate) artifact_save_failed: &'static str,
    pub(crate) view_work: &'static str,
    pub(crate) file: &'static str,
    pub(crate) open: &'static str,
    pub(crate) more: &'static str,
    /// conversation.changedFiles: noLineDetails
    pub(crate) no_line_details: &'static str,
    /// conversation.answerBlocks: showMore, showLess, saveToLibrary, savedToLibrary, copy,
    /// copied, actionFailed
    pub(crate) answer_show_more: &'static str,
    pub(crate) show_less: &'static str,
    pub(crate) save_to_library: &'static str,
    pub(crate) saved_to_library: &'static str,
    pub(crate) copy: &'static str,
    pub(crate) answer_copied: &'static str,
    pub(crate) action_failed: &'static str,
    /// conversation.imageViewer
    pub(crate) close: &'static str,
    pub(crate) previous_image: &'static str,
    pub(crate) next_image: &'static str,
    pub(crate) image_unavailable: &'static str,
    pub(crate) zoom_in: &'static str,
    pub(crate) zoom_out: &'static str,
    pub(crate) copy_image: &'static str,
    pub(crate) image_copied: &'static str,
    pub(crate) open_source: &'static str,
    /// composer and conversation.messageActions strings of the queued rows
    pub(crate) queued_message: &'static str,
    pub(crate) sending_status: &'static str,
    pub(crate) failed_message_status: &'static str,
    pub(crate) queued_message_status: &'static str,
    pub(crate) edit_queued_message: &'static str,
    pub(crate) delete_queued_message: &'static str,
    pub(crate) retry_failed_message: &'static str,
    pub(crate) delete_failed_message: &'static str,
    pub(crate) send_now: &'static str,
    pub(crate) queue_show_more: &'static str,
    pub(crate) queue_show_less: &'static str,
    /// conversation.messageActions.sendNowFailed
    pub(crate) send_now_failed: &'static str,
}

const KO: Media = Media {
    copy_code: "코드 복사",
    copied: "복사됨",
    save: "저장하기",
    artifact_saved: "아티팩트를 저장했습니다",
    artifact_save_failed: "아티팩트를 저장하지 못했습니다",
    view_work: "작업 보기",
    file: "파일",
    open: "열기",
    more: "더보기",
    no_line_details: "라인 상세 없음",
    answer_show_more: "더 보기",
    show_less: "접기",
    save_to_library: "서랍에 저장",
    saved_to_library: "서랍에 저장했어요",
    copy: "복사",
    answer_copied: "복사했어요",
    action_failed: "실행하지 못했어요",
    close: "닫기",
    previous_image: "이전 이미지",
    next_image: "다음 이미지",
    image_unavailable: "이미지를 불러오지 못했어요",
    zoom_in: "확대",
    zoom_out: "축소",
    copy_image: "이미지 복사",
    image_copied: "이미지를 복사했어요",
    open_source: "원본 페이지 열기",
    queued_message: "대기 중인 메시지",
    sending_status: "보내는 중…",
    failed_message_status: "전송 실패",
    queued_message_status: "대기 중",
    edit_queued_message: "대기 메시지 수정",
    delete_queued_message: "대기 메시지 삭제",
    retry_failed_message: "다시 작성",
    delete_failed_message: "실패 메시지 삭제",
    send_now: "지금 보내기",
    queue_show_more: "더보기",
    queue_show_less: "접기",
    send_now_failed: "보내지 못했습니다",
};

const EN: Media = Media {
    copy_code: "Copy code",
    copied: "Copied",
    save: "Save",
    artifact_saved: "Artifact saved",
    artifact_save_failed: "Could not save artifact",
    view_work: "View work",
    file: "File",
    open: "Open",
    more: "More",
    no_line_details: "No line details",
    answer_show_more: "Show more",
    show_less: "Show less",
    save_to_library: "Save to library",
    saved_to_library: "Saved to library",
    copy: "Copy",
    answer_copied: "Copied",
    action_failed: "Action failed",
    close: "Close",
    previous_image: "Previous image",
    next_image: "Next image",
    image_unavailable: "Image unavailable",
    zoom_in: "Zoom in",
    zoom_out: "Zoom out",
    copy_image: "Copy image",
    image_copied: "Image copied",
    open_source: "Open source page",
    queued_message: "Queued message",
    sending_status: "Sending…",
    failed_message_status: "Send failed",
    queued_message_status: "Queued",
    edit_queued_message: "Edit queued message",
    delete_queued_message: "Delete queued message",
    retry_failed_message: "Retry message",
    delete_failed_message: "Delete failed message",
    send_now: "Send now",
    queue_show_more: "Show more",
    queue_show_less: "Show less",
    send_now_failed: "Couldn't send",
};

impl Media {
    /// The copy of `lang`.
    pub(crate) fn of(lang: Lang) -> &'static Self {
        match lang {
            Lang::Ko => &KO,
            Lang::En => &EN,
        }
    }

    /// The copy of the app language.
    pub(crate) fn get(cx: &App) -> &'static Self {
        Self::of(Ds::get(cx).lang())
    }

    /// conversation.changedFiles.title: the changed-files heading.
    pub(crate) fn file_changes(lang: Lang, count: usize, added: i64, deleted: i64) -> String {
        match lang {
            Lang::Ko => format!("파일 변경 {count}개 · +{added} −{deleted}"),
            Lang::En => format!("File changes {count} · +{added} −{deleted}"),
        }
    }

    /// conversation.changedFiles.newFile
    pub(crate) fn new_file(lang: Lang, size: &str) -> String {
        match lang {
            Lang::Ko => format!("새 파일 · {size}"),
            Lang::En => format!("New file · {size}"),
        }
    }

    /// conversation.changedFiles.showMore: the fold's toggle.
    pub(crate) fn files_toggle(lang: Lang, open: bool, remaining: usize) -> String {
        match (open, lang) {
            (true, Lang::Ko) => "접기".to_owned(),
            (true, Lang::En) => "Show less".to_owned(),
            (false, Lang::Ko) => format!("더보기 ({remaining}개)"),
            (false, Lang::En) => format!("Show more ({remaining})"),
        }
    }

    /// conversation.answerBlocks.showMoreItems
    pub(crate) fn show_more_items(lang: Lang, count: usize) -> String {
        match lang {
            Lang::Ko => format!("{count}개 더 보기"),
            Lang::En => format!("Show {count} more"),
        }
    }

    /// conversation.imageViewer.checked
    pub(crate) fn checked(lang: Lang, time: &str) -> String {
        match lang {
            Lang::Ko => format!("{time} 확인"),
            Lang::En => format!("Checked {time}"),
        }
    }

    /// composer.queuedPosition
    pub(crate) fn queued_position(lang: Lang, position: usize, total: usize) -> String {
        match lang {
            Lang::Ko => format!("대기 중 · {total}개 중 {position}번째"),
            Lang::En => format!("Queued · {position} of {total}"),
        }
    }

    /// composer.queuedAttachmentCount
    pub(crate) fn queued_attachment_count(lang: Lang, count: usize) -> String {
        match lang {
            Lang::Ko => format!("첨부 {count}개"),
            Lang::En => format!("{count} attachments"),
        }
    }
}
