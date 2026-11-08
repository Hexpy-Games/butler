//! The copy of the Models page (`appCopy.settings` keys of `ModelsSettings` and its parts).
//! Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

pub(crate) struct Words {
    /// settings.pageSections.butlerModel
    pub(crate) butler_model_section: &'static str,
    /// settings.pageSections.backupModels
    pub(crate) backup_models_section: &'static str,
    /// settings.pageSections.imageModels
    pub(crate) image_models_section: &'static str,
    /// settings.pageSections.workerProfiles
    pub(crate) worker_profiles_section: &'static str,
    /// settings.modelsAdvanced.title
    pub(crate) advanced_title: &'static str,
    /// settings.modelsAdvanced.contents
    pub(crate) advanced_contents: &'static str,
    /// settings.workerProfilesPanel.add
    pub(crate) worker_add: &'static str,
    /// settings.workerProfilesPanel.addLimitReached
    pub(crate) worker_add_limit_reached: &'static str,
    /// settings.workerProfilesPanel.maxSimultaneousWorkers
    pub(crate) worker_max_simultaneous: &'static str,
    /// settings.fields.butlerModel and settings.fields.model (the same text)
    pub(crate) model: &'static str,
    /// settings.fields.butlerReasoning and settings.fields.reasoning (the same text)
    pub(crate) reasoning: &'static str,
    /// settings.fields.localReasoningBudget
    pub(crate) local_reasoning_budget: &'static str,
    /// settings.fields.contextLimit
    pub(crate) context_limit: &'static str,
    /// settings.fields.name
    pub(crate) name: &'static str,
    /// settings.fields.job
    pub(crate) job: &'static str,
    /// settings.fields.customJob
    pub(crate) custom_job: &'static str,
    /// settings.fields.domain
    pub(crate) domain: &'static str,
    /// settings.fields.workerPrompt
    pub(crate) worker_prompt: &'static str,
    /// settings.fields.enabled
    pub(crate) enabled: &'static str,
    /// settings.descriptions.runtimeSupportedModelsOnly
    pub(crate) runtime_models_only: &'static str,
    /// settings.descriptions.localReasoningBudget
    pub(crate) local_reasoning_budget_description: &'static str,
    /// settings.descriptions.contextLimit(maxLabel)
    pub(crate) context_limit_description: fn(&str) -> String,
    /// settings.descriptions.contextLimitClamped(value)
    pub(crate) context_limit_clamped: fn(&str) -> String,
    /// settings.errors.updateLocalReasoningBudget
    pub(crate) update_local_budget_failed: &'static str,
    /// settings.modelManagement.manageButton
    pub(crate) manage_models: &'static str,
    /// settings.modelManagement.title
    pub(crate) management_title: &'static str,
    /// settings.modelManagement.addTitle
    pub(crate) add_title: &'static str,
    /// settings.modelManagement.editTitle
    pub(crate) edit_title: &'static str,
    /// settings.backupModels.title
    pub(crate) backup_title: &'static str,
    /// settings.backupModels.description
    pub(crate) backup_description: &'static str,
    /// settings.backupModels.enabled
    pub(crate) backup_enabled: &'static str,
    /// settings.backupModels.enabledDescription
    pub(crate) backup_enabled_description: &'static str,
    /// settings.backupModels.add
    pub(crate) backup_add: &'static str,
    /// settings.backupModels.addTitle
    pub(crate) backup_add_title: &'static str,
    /// settings.backupModels.searchPlaceholder
    pub(crate) backup_search: &'static str,
    /// settings.backupModels.allProviders
    pub(crate) backup_all_providers: &'static str,
    /// settings.backupModels.empty
    pub(crate) backup_empty: &'static str,
    /// settings.backupModels.noCandidates
    pub(crate) backup_no_candidates: &'static str,
    /// settings.backupModels.limitReached
    pub(crate) backup_limit_reached: &'static str,
    /// settings.backupModels.summaryDescription
    pub(crate) backup_summary_description: &'static str,
    /// settings.backupModels.off
    pub(crate) backup_off: &'static str,
    /// settings.backupModels.edit
    pub(crate) backup_edit: &'static str,
    /// settings.backupModels.done
    pub(crate) backup_done: &'static str,
    /// settings.workerJobs.{coding, research, debug, review, writing}, in `BUILTIN_JOBS` order
    pub(crate) job_labels: [&'static str; 5],
    /// settings.workerJobs.custom
    pub(crate) job_custom: &'static str,
    /// common.delete
    pub(crate) delete: &'static str,
    /// common.breadcrumb
    pub(crate) breadcrumb: &'static str,
}

fn context_limit_en(max: &str) -> String {
    format!("The active Butler context budget. Model maximum: {max}.")
}

fn context_limit_ko(max: &str) -> String {
    format!("실제 버틀러 컨텍스트 예산입니다. 모델 최대값: {max}.")
}

fn clamped_en(value: &str) -> String {
    format!("Context limit adjusted to {value} tokens.")
}

fn clamped_ko(value: &str) -> String {
    format!("컨텍스트 한도를 {value} 토큰으로 조정했습니다.")
}

static KO: Words = Words {
    butler_model_section: "버틀러 모델",
    backup_models_section: "예비 모델",
    image_models_section: "이미지 모델",
    worker_profiles_section: "작업자 설정",
    advanced_title: "고급",
    advanced_contents: "작업자 설정",
    worker_add: "작업자 추가",
    worker_add_limit_reached: "작업자는 최대 12명까지 등록할 수 있습니다.",
    worker_max_simultaneous: "작업당 최대 작업자 수",
    model: "모델",
    reasoning: "추론",
    local_reasoning_budget: "로컬 추론 예산",
    context_limit: "컨텍스트 한도",
    name: "이름",
    job: "작업",
    custom_job: "사용자 지정 작업",
    domain: "도메인",
    worker_prompt: "작업자 프롬프트",
    enabled: "사용",
    runtime_models_only: "현재 실행 가능한 제공자의 모델만 표시합니다.",
    local_reasoning_budget_description: "선택한 로컬 모델의 최대 출력 토큰 중 추론에 사용할 비율입니다.",
    context_limit_description: context_limit_ko,
    context_limit_clamped: clamped_ko,
    update_local_budget_failed: "로컬 추론 예산 업데이트 실패",
    manage_models: "모델 관리",
    management_title: "모델 관리",
    add_title: "모델 추가",
    edit_title: "모델 편집",
    backup_title: "예비 모델",
    backup_description: "현재 모델이 일시적으로 응답하지 않을 때 같은 작업을 이어갈 모델을 순서대로 선택합니다.",
    backup_enabled: "예비 모델 사용",
    backup_enabled_description: "켜면 새 작업부터 등록한 순서대로 예비 모델을 사용할 수 있습니다.",
    backup_add: "예비 모델 추가",
    backup_add_title: "예비 모델 선택",
    backup_search: "모델 또는 제공자 검색",
    backup_all_providers: "모든 제공자",
    backup_empty: "등록된 예비 모델이 없습니다.",
    backup_no_candidates: "추가할 수 있는 모델이 없습니다.",
    backup_limit_reached: "예비 모델은 최대 5개까지 등록할 수 있습니다.",
    backup_summary_description: "현재 모델이 실패하면 이어받습니다.",
    backup_off: "사용 안 함",
    backup_edit: "편집",
    backup_done: "완료",
    job_labels: ["코딩", "리서치", "디버깅", "리뷰", "글쓰기"],
    job_custom: "사용자 지정",
    delete: "삭제",
    breadcrumb: "현재 위치",
};

static EN: Words = Words {
    butler_model_section: "Butler model",
    backup_models_section: "Backup models",
    image_models_section: "Image model",
    worker_profiles_section: "Worker profiles",
    advanced_title: "Advanced",
    advanced_contents: "Worker settings",
    worker_add: "Add Worker profile",
    worker_add_limit_reached: "You can register up to 12 worker profiles.",
    worker_max_simultaneous: "Max workers per task",
    model: "Model",
    reasoning: "Reasoning",
    local_reasoning_budget: "Local reasoning budget",
    context_limit: "Context limit",
    name: "Name",
    job: "Job",
    custom_job: "Custom job",
    domain: "Domain",
    worker_prompt: "Worker prompt",
    enabled: "Enabled",
    runtime_models_only: "Only models from currently runnable providers are shown.",
    local_reasoning_budget_description: "The share of the selected local model output tokens reserved for reasoning.",
    context_limit_description: context_limit_en,
    context_limit_clamped: clamped_en,
    update_local_budget_failed: "Failed to update local reasoning budget",
    manage_models: "Manage models",
    management_title: "Model management",
    add_title: "Add model",
    edit_title: "Edit model",
    backup_title: "Backup models",
    backup_description: "Choose ordered models that can continue the same task when the current model is temporarily unavailable.",
    backup_enabled: "Use backup models",
    backup_enabled_description: "When enabled, new tasks can advance through the registered models in order.",
    backup_add: "Add backup model",
    backup_add_title: "Choose a backup model",
    backup_search: "Search models or providers",
    backup_all_providers: "All providers",
    backup_empty: "No backup models are registered.",
    backup_no_candidates: "No models are available to add.",
    backup_limit_reached: "You can register up to 5 backup models.",
    backup_summary_description: "Take over when the current model fails.",
    backup_off: "Off",
    backup_edit: "Edit",
    backup_done: "Done",
    job_labels: ["Coding", "Research", "Debug", "Review", "Writing"],
    job_custom: "Custom",
    delete: "Delete",
    breadcrumb: "Location",
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// The copy of the app language.
pub(crate) fn get(cx: &App) -> &'static Words {
    words(Ds::get(cx).lang())
}
