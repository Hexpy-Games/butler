//! The composer's labels of a refused image and of a reasoning effort.
use butler_ds::ui::context::Lang;

use crate::ui::composer::state::ImageRefusal;
use crate::ui::source::wire::ReasoningEffort;

/// `imageRefusalLabel`: few-word reason for tooltips and the refusal toast.
pub(crate) fn image_refusal_label(refusal: ImageRefusal, lang: Lang) -> &'static str {
    let ko = lang == Lang::Ko;
    match refusal {
        ImageRefusal::Model if ko => "이미지 미지원 모델",
        ImageRefusal::Model => "Model doesn't accept images",
        ImageRefusal::Unknown if ko => "이미지 지원 여부를 확인할 수 없는 모델",
        ImageRefusal::Unknown => "Image support unknown for this model",
        ImageRefusal::Undeclared if ko => "설정 → 모델에서 이미지 입력을 켜세요",
        ImageRefusal::Undeclared => "Turn on image input in Settings",
        ImageRefusal::Type if ko => "지원하지 않는 이미지 형식",
        ImageRefusal::Type => "Image type not supported",
        ImageRefusal::Size if ko => "이미지 용량 초과",
        ImageRefusal::Size => "Image too large",
    }

/// `reasoningEffortLabel` (butler-i18n/src/reasoning-effort.ts).
pub(crate) fn reasoning_label(value: &ReasoningEffort, lang: Lang) -> &'static str {
    let ko = lang == Lang::Ko;
    match value {
        ReasoningEffort::None if ko => "없음",
        ReasoningEffort::None => "None",
        ReasoningEffort::Low if ko => "낮음",
        ReasoningEffort::Low => "Low",
        ReasoningEffort::Medium | ReasoningEffort::Unknown if ko => "보통",
        ReasoningEffort::Medium | ReasoningEffort::Unknown => "Medium",
        ReasoningEffort::High if ko => "높음",
        ReasoningEffort::High => "High",
        ReasoningEffort::Xhigh if ko => "매우 높음",
        ReasoningEffort::Xhigh => "Very high",
        ReasoningEffort::Max if ko => "최대",
        ReasoningEffort::Max => "Max",
    }
