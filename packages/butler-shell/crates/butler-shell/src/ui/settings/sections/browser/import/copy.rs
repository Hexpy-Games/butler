//! The copy of the browser import. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// settings.pageSections.browserImport
    pub(super) title: &'static str,
    /// settings.browserImport.dataLabel
    pub(super) data_label: &'static str,
    /// settings.browserImport.purpose
    pub(super) purpose: &'static str,
    /// settings.browserImport.open
    pub(super) open: &'static str,
    /// settings.browserImport.chooseBrowser
    pub(super) choose_browser: &'static str,
    /// settings.browserImport.chooseItems
    pub(super) choose_items: &'static str,
    /// settings.browserImport.run
    pub(super) run: &'static str,
    /// settings.browserImport.fromFile
    pub(super) from_file: &'static str,
    /// settings.browserImport.htmlFile, csvFile
    pub(super) html_file: &'static str,
    pub(super) csv_file: &'static str,
    /// settings.browserImport.bookmarks, passwords, history
    pub(super) bookmarks: &'static str,
    pub(super) passwords: &'static str,
    pub(super) history: &'static str,
    /// settings.browserImport.noSources
    pub(super) no_sources: &'static str,
    /// settings.browserImport.needsKeychain
    pub(super) needs_keychain: &'static str,
    /// settings.browserImport.importing
    pub(super) importing: &'static str,
    /// settings.browserImport.waitingCsv
    pub(super) waiting_csv: &'static str,
    /// settings.browserImport.failed
    pub(super) failed: &'static str,
    /// settings.browserImport.fullDiskAccess
    pub(super) full_disk_access: &'static str,
    /// settings.browserImport.restartAfterAccess
    pub(super) restart_after_access: &'static str,
    /// settings.browserImport.primaryPassword, wrongPrimaryPassword
    pub(super) primary_password: &'static str,
    pub(super) wrong_primary_password: &'static str,
    /// settings.browserImport.closeBrowser
    pub(super) close_browser: &'static str,
    /// settings.browserImport.cancel, back, next, done, retry, more
    pub(super) cancel: &'static str,
    pub(super) back: &'static str,
    pub(super) next: &'static str,
    pub(super) done: &'static str,
    pub(super) retry: &'static str,
    pub(super) more: &'static str,
    /// settings.browserImport.chooseFile, pickFolder, diskAccess, exportPasswords, deleteCsv
    pub(super) choose_file: &'static str,
    pub(super) pick_folder: &'static str,
    pub(super) disk_access: &'static str,
    pub(super) export_passwords: &'static str,
    pub(super) delete_csv: &'static str,
}

/// settings.browserImport.result, from: bookmarks, visits, passwords added, updated, skipped.
pub(super) fn result_line(lang: Lang, counts: [u64; 5]) -> String {
    let [bookmarks, history, passwords, updated, invalid] = counts;
    let (line, updated, skipped) = match lang {
        Lang::Ko => (
            format!("북마크 {bookmarks}개 · 방문 기록 {history}개 · 비밀번호 {passwords}개 추가"),
            format!(", {updated}개 갱신"),
            format!(" · {invalid}개 건너뜀"),
        ),
        Lang::En => (
            format!("{bookmarks} bookmarks · {history} visits · {passwords} passwords added"),
            format!(", {updated} updated"),
            format!(" · {invalid} skipped"),
        ),
    };
    let updated = if counts[3] > 0 {
        updated
    } else {
        String::new()
    };
    let skipped = if invalid > 0 { skipped } else { String::new() };
    format!("{line}{updated}{skipped}")
}

static KO: Words = Words {
    title: "다른 브라우저에서 가져오기",
    data_label: "브라우저 데이터",
    purpose: "북마크, 비밀번호, 방문 기록을 버틀러로 옮겨요",
    open: "브라우저 가져오기",
    choose_browser: "브라우저 선택",
    choose_items: "가져올 항목",
    run: "가져오기",
    from_file: "파일에서 가져오기",
    html_file: "북마크 HTML 파일",
    csv_file: "비밀번호 CSV 파일",
    bookmarks: "북마크",
    passwords: "비밀번호",
    history: "방문 기록",
    no_sources: "찾은 브라우저가 없어요",
    needs_keychain: "시스템 암호 저장소가 있어야 가져올 수 있어요",
    importing: "가져오는 중…",
    waiting_csv: "다운로드 폴더에서 새 CSV를 기다리는 중…",
    failed: "가져오지 못했어요",
    full_disk_access: "브라우저 폴더 접근 권한이 필요해요",
    restart_after_access: "권한을 허용한 뒤 버틀러를 다시 시작하세요",
    primary_password: "기본 비밀번호",
    wrong_primary_password: "기본 비밀번호를 확인하세요",
    close_browser: "브라우저를 닫고 다시 시도",
    cancel: "취소",
    back: "이전",
    next: "다음",
    done: "완료",
    retry: "다시 시도",
    more: "더 가져오기",
    choose_file: "파일 선택",
    pick_folder: "브라우저 폴더 선택",
    disk_access: "전체 디스크 접근 설정",
    export_passwords: "비밀번호 내보내기",
    delete_csv: "CSV 파일 삭제",
};

static EN: Words = Words {
    title: "Import from another browser",
    data_label: "Browser data",
    purpose: "Bring bookmarks, passwords and history into Butler",
    open: "Import from a browser",
    choose_browser: "Choose a browser",
    choose_items: "Include",
    run: "Import",
    from_file: "Import from a file",
    html_file: "Bookmarks HTML file",
    csv_file: "Passwords CSV file",
    bookmarks: "Bookmarks",
    passwords: "Passwords",
    history: "History",
    no_sources: "No browsers found",
    needs_keychain: "Needs the system password store",
    importing: "Importing…",
    waiting_csv: "Waiting for a new CSV in Downloads…",
    failed: "Couldn't import",
    full_disk_access: "Allow access to the browser folder",
    restart_after_access: "Allow access, then restart Butler",
    primary_password: "Primary password",
    wrong_primary_password: "Check the primary password",
    close_browser: "Close the browser and retry",
    cancel: "Cancel",
    back: "Back",
    next: "Next",
    done: "Done",
    retry: "Retry",
    more: "Import more",
    choose_file: "Choose file",
    pick_folder: "Choose browser folder",
    disk_access: "Full Disk Access settings",
    export_passwords: "Export passwords",
    delete_csv: "Delete CSV file",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
