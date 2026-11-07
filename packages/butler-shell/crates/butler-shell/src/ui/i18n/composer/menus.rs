//! The model chooser's copy.
use butler_ds::ui::context::Lang;

/// `appCopy.composer` strings of the model chooser.
pub(crate) struct Copy {
    pub(crate) model: &'static str,
    pub(crate) search: &'static str,
    pub(crate) all_providers: &'static str,
    pub(crate) no_models: &'static str,
    pub(crate) reasoning: &'static str,
    pub(crate) context_unknown: &'static str,
}

const EN: Copy = Copy {
    model: "Model",
    search: "Search models...",
    all_providers: "All",
    no_models: "No models found",
    reasoning: "Reasoning",
    context_unknown: "context unknown",
};

const KO: Copy = Copy {
    model: "모델",
    search: "모델 검색...",
    all_providers: "전체",
    no_models: "모델을 찾을 수 없습니다",
    reasoning: "추론",
    context_unknown: "컨텍스트 미확인",
};

pub(crate) fn copy(lang: Lang) -> &'static Copy {
    if lang == Lang::Ko { &KO } else { &EN }
}
