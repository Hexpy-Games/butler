//! The copy of the approved actions, API keys and connected accounts. Each field names its
//! `packages/butler-i18n` key (`settings.*`). A `{}` is filled by the caller.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    lang: Lang,
    /// pageSections.grants
    pub(super) grants_title: &'static str,
    /// pageSectionDescriptions.grants
    pub(super) grants_description: &'static str,
    /// pageSections.savedKeys
    pub(super) keys_title: &'static str,
    /// pageSections.connectedAccounts
    pub(super) accounts_title: &'static str,
    /// space.general
    pub(super) general: &'static str,
    /// grants.kind.command, fileWrite, network, tool, other
    pub(super) kinds: [&'static str; 5],
    /// grants.scope.conversation, project, always
    pub(super) scopes: [&'static str; 3],
    /// grants.conversations
    pub(super) conversations: &'static str,
    /// grants.cwd
    pub(super) cwd: &'static str,
    /// grants.revoke
    pub(super) revoke: &'static str,
    /// grants.revokeAlwaysTitle
    pub(super) revoke_always_title: &'static str,
    /// grants.revokeAlwaysMessage
    pub(super) revoke_always_message: &'static str,
    /// grants.revoked
    pub(super) revoked: &'static str,
    /// grants.search
    pub(super) search: &'static str,
    /// grants.filterAll
    pub(super) filter_all: &'static str,
    /// grants.empty
    pub(super) grants_empty: &'static str,
    /// grants.noMatch
    pub(super) no_match: &'static str,
    /// grants.targetUnknown
    pub(super) target_unknown: &'static str,
    /// grants.deletedChat
    pub(super) deleted_chat: &'static str,
    /// grants.loadFailed
    pub(super) grants_load_failed: &'static str,
    /// grants.revokeFailed
    pub(super) revoke_failed: &'static str,
    /// savedKeys.empty
    pub(super) keys_empty: &'static str,
    /// savedKeys.usedBy for 0, 1 and more models
    pub(super) used_by: [&'static str; 3],
    /// savedKeys.storage.local, keychain, secretService, credentialManager
    pub(super) storage: [&'static str; 4],
    /// savedKeys.replace
    pub(super) replace: &'static str,
    /// savedKeys.newKey
    pub(super) new_key: &'static str,
    /// savedKeys.save
    pub(super) save: &'static str,
    /// savedKeys.cancel
    pub(super) cancel: &'static str,
    /// savedKeys.checking
    pub(super) checking: &'static str,
    /// savedKeys.replacedStatus
    pub(super) replaced_status: &'static str,
    /// savedKeys.delete
    pub(super) delete: &'static str,
    /// savedKeys.deleteDefaultHint
    pub(super) delete_default_hint: &'static str,
    /// savedKeys.deleteConfirm
    pub(super) delete_confirm: &'static str,
    /// savedKeys.deletedStatus
    pub(super) deleted_status: &'static str,
    /// savedKeys.errors.delete
    pub(super) delete_error: &'static str,
    /// firstRun.keyErrors.savefailed (the client reports no key-check code)
    pub(super) key_save_failed: &'static str,
    /// connectedAccounts.empty
    pub(super) accounts_empty: &'static str,
    /// connectedAccounts.provider
    pub(super) provider: &'static str,
    /// connectedAccounts.kind.sign_in, legacy_sign_in
    pub(super) account_kinds: [&'static str; 2],
    /// connectedAccounts.obtained
    pub(super) obtained: &'static str,
    /// connectedAccounts.expires
    pub(super) expires: &'static str,
    /// connectedAccounts.signOut
    pub(super) sign_out: &'static str,
    /// connectedAccounts.signOutOf
    pub(super) sign_out_of: &'static str,
    /// connectedAccounts.confirm
    pub(super) sign_out_confirm: &'static str,
    /// connectedAccounts.done
    pub(super) signed_out: &'static str,
    /// connectedAccounts.revokeUnconfirmed
    pub(super) revoke_unconfirmed: &'static str,
    /// connectedAccounts.error
    pub(super) sign_out_error: &'static str,
    /// security.working
    pub(super) working: &'static str,
}

static KO: Words = Words {
    lang: Lang::Ko,
    grants_title: "허용한 작업",
    grants_description: "묻지 않고 실행하도록 허용한 작업입니다.",
    keys_title: "API 키",
    accounts_title: "연결된 계정",
    general: "일반",
    kinds: [
        "명령 실행",
        "파일 쓰기",
        "네트워크",
        "외부 도구",
        "기타 작업",
    ],
    scopes: ["대화", "프로젝트", "항상"],
    conversations: "대화 {}개",
    cwd: "위치 {}",
    revoke: "허용 해제",
    revoke_always_title: "항상 허용을 해제할까요?",
    revoke_always_message: "다음부터는 실행 전에 묻습니다.",
    revoked: "허용을 해제했습니다.",
    search: "허용한 작업 검색",
    filter_all: "전체",
    grants_empty: "허용한 작업이 없습니다.",
    no_match: "검색 결과가 없습니다.",
    target_unknown: "대상 정보 없음",
    deleted_chat: "삭제된 대화",
    grants_load_failed: "허용 목록을 불러오지 못했습니다.",
    revoke_failed: "허용을 해제하지 못했습니다.",
    keys_empty: "저장된 API 키가 없습니다.",
    used_by: ["사용 안 함", "모델 1개", "모델 {}개"],
    storage: [
        "이 컴퓨터에만 저장",
        "키체인에 저장",
        "시스템 키링에 저장",
        "자격 증명 관리자에 저장",
    ],
    replace: "교체",
    new_key: "새 키",
    save: "저장",
    cancel: "취소",
    checking: "확인 중",
    replaced_status: "{} 키를 교체했습니다.",
    delete: "삭제",
    delete_default_hint: "기본 모델을 먼저 바꾸세요",
    delete_confirm: "{} 키를 삭제할까요?",
    deleted_status: "{} 키를 삭제했습니다.",
    delete_error: "키 삭제 실패",
    key_save_failed: "키를 저장하지 못했습니다. 다시 시도하세요.",
    accounts_empty: "연결된 계정 없음",
    provider: "ChatGPT",
    account_kinds: ["ChatGPT 로그인", "ChatGPT 이전 로그인"],
    obtained: "{} 로그인",
    expires: "{} 만료",
    sign_out: "로그아웃",
    sign_out_of: "{} 로그아웃",
    sign_out_confirm: "{} 계정에서 로그아웃할까요? 버틀러에 저장된 인증 정보가 삭제돼요.",
    signed_out: "로그아웃했어요",
    revoke_unconfirmed: "로그아웃했어요. 서비스 쪽 해제는 확인하지 못했어요.",
    sign_out_error: "로그아웃하지 못했어요",
    working: "처리 중이에요",
};

static EN: Words = Words {
    lang: Lang::En,
    grants_title: "Approved actions",
    grants_description: "Actions Butler runs without asking.",
    keys_title: "API keys",
    accounts_title: "Connected accounts",
    general: "General",
    kinds: [
        "Run command",
        "Write files",
        "Network",
        "External tool",
        "Other action",
    ],
    scopes: ["Chat", "Project", "Always"],
    conversations: "{} chats",
    cwd: "In {}",
    revoke: "Revoke",
    revoke_always_title: "Revoke this always-on approval?",
    revoke_always_message: "Butler will ask before running it again.",
    revoked: "Revoked.",
    search: "Search approvals",
    filter_all: "All",
    grants_empty: "No approved actions.",
    no_match: "No matches.",
    target_unknown: "Target not recorded",
    deleted_chat: "Deleted chat",
    grants_load_failed: "Couldn't load approvals.",
    revoke_failed: "Couldn't revoke it.",
    keys_empty: "No saved API keys.",
    used_by: ["Not in use", "1 model", "{} models"],
    storage: [
        "Stored only on this computer",
        "Stored in Keychain",
        "Stored in the system keyring",
        "Stored in Credential Manager",
    ],
    replace: "Replace",
    new_key: "New key",
    save: "Save",
    cancel: "Cancel",
    checking: "Checking",
    replaced_status: "{} key replaced.",
    delete: "Delete",
    delete_default_hint: "Change the default model first",
    delete_confirm: "Delete the {} key?",
    deleted_status: "{} key deleted.",
    delete_error: "Failed to delete key",
    key_save_failed: "Couldn't save the key. Try again.",
    accounts_empty: "No connected accounts",
    provider: "ChatGPT",
    account_kinds: ["ChatGPT sign-in", "Old ChatGPT sign-in"],
    obtained: "Signed in {}",
    expires: "Expires {}",
    sign_out: "Sign out",
    sign_out_of: "Sign out of {}",
    sign_out_confirm: "Sign out of {}? Butler deletes its saved credential.",
    signed_out: "Signed out",
    revoke_unconfirmed: "Signed out. The provider didn't confirm.",
    sign_out_error: "Couldn't sign out",
    working: "Working…",
};

impl Words {
    pub(super) fn of(lang: Lang) -> &'static Self {
        match lang {
            Lang::Ko => &KO,
            Lang::En => &EN,
        }
    }

    pub(super) fn lang(&self) -> Lang {
        self.lang
    }

    /// Fills the `{}` of a template.
    pub(super) fn fill(template: &str, value: &str) -> String {
        template.replacen("{}", value, 1)
    }

    /// savedKeys.usedBy
    pub(super) fn used_by(&self, count: usize) -> String {
        let template = self.used_by[count.min(2)];
        Self::fill(template, &count.to_string())
    }

    /// savedKeys.deleteConfirmModels
    pub(super) fn delete_confirm_models(&self, name: &str, count: usize) -> String {
        match self.lang {
            Lang::Ko => {
                format!("{name} 키를 삭제할까요? 이 키를 쓰는 모델 {count}개도 함께 삭제됩니다.")
            }
            Lang::En => {
                let models = if count == 1 {
                    "1 model uses".to_owned()
                } else {
                    format!("{count} models use")
                };
                format!("Delete the {name} key? {models} it and will be removed.")
            }
        }
    }
}
