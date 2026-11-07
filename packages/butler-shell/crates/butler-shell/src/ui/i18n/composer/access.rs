//! The access-mode menu, the plan badge, the workspace select and the model status button.
use butler_ds::ui::context::Lang;

/// One access mode's label and description.
pub(crate) struct AccessText {
    pub(crate) label: &'static str,
    pub(crate) description: &'static str,
}

pub(crate) struct AccessCopy {
    pub(crate) read_only: AccessText,
    pub(crate) ask_every_time: AccessText,
    pub(crate) ask_first: AccessText,
    pub(crate) auto: AccessText,
    pub(crate) full_access: AccessText,
    pub(crate) permission: &'static str,
    pub(crate) plan: &'static str,
    pub(crate) cancel: &'static str,
    pub(crate) local: &'static str,
    pub(crate) worktree: &'static str,
    pub(crate) checking_model: &'static str,
    pub(crate) no_model: &'static str,
    pub(crate) not_in_plan: &'static str,
    pub(crate) sign_in_again: &'static str,
    pub(crate) add_model: &'static str,
}

const EN: AccessCopy = AccessCopy {
    read_only: AccessText {
        label: "Read only",
        description: "Can only read files",
    },
    ask_every_time: AccessText {
        label: "Ask every time",
        description: "Ask before every action",
    },
    ask_first: AccessText {
        label: "Ask first",
        description: "Ask before changes and commands",
    },
    auto: AccessText {
        label: "Auto",
        description: "Ask only for risky actions",
    },
    full_access: AccessText {
        label: "Full access",
        description: "Never ask",
    },
    permission: "Permission",
    plan: "Plan",
    cancel: "Cancel",
    local: "Local",
    worktree: "Worktree",
    checking_model: "Checking model",
    no_model: "No model",
    not_in_plan: "Not in your ChatGPT plan",
    sign_in_again: "Sign in to ChatGPT again",
    add_model: "Add a model in Settings.",
};

const KO: AccessCopy = AccessCopy {
    read_only: AccessText {
        label: "읽기 전용",
        description: "파일 읽기만 가능",
    },
    ask_every_time: AccessText {
        label: "모두 확인",
        description: "모든 작업 전에 확인",
    },
    ask_first: AccessText {
        label: "먼저 확인",
        description: "변경·명령 전에 확인",
    },
    auto: AccessText {
        label: "알아서 진행",
        description: "위험한 작업만 확인",
    },
    full_access: AccessText {
        label: "전체 권한",
        description: "확인 없이 진행",
    },
    permission: "권한",
    plan: "계획",
    cancel: "취소",
    local: "로컬",
    worktree: "워크트리",
    checking_model: "모델 확인 중",
    no_model: "모델 없음",
    not_in_plan: "ChatGPT 플랜에 없는 모델",
    sign_in_again: "ChatGPT에 다시 로그인하세요",
    add_model: "설정에서 모델을 추가해 주세요.",
};

pub(crate) fn copy(lang: Lang) -> &'static AccessCopy {
    if lang == Lang::Ko { &KO } else { &EN }
}
