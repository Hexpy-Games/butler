use std::path::Path;

use super::super::contracts::{FirstChatOnboardingState, PersonalizationProfile};
use super::super::presets::{PersonaLocale, PersonaPresets};
use super::read;
use crate::profile::naming;
pub(in crate::profile) fn render(
    data_root: &Path,
    presets: &PersonaPresets,
    locale: PersonaLocale,
    now: &str,
) -> Option<String> {
    let state = read(data_root, now);
    if state.status == "complete" {
        return None;
    }
    let profile = naming::read(data_root);
    let missing = missing(&profile, &state);
    let known = known(&profile, &state, locale);
    let options = presets
        .list(locale)
        .into_iter()
        .map(|preset| {
            let label = if preset.label == preset.name {
                preset.name.clone()
            } else {
                format!("{} ({})", preset.name, preset.label)
            };
            if preset.preview.is_empty() {
                format!("- persona_preset: {label}")
            } else {
                format!("- persona_preset: {label} - {}", preset.preview)
            }
        })
        .collect::<Vec<_>>();
    let next = missing
        .first()
        .map(String::as_str)
        .unwrap_or(if locale == PersonaLocale::Ko {
            "완료 확인"
        } else {
            "completion confirmation"
        });
    if locale == PersonaLocale::Ko {
        Some([
            vec![
                "첫 대화 온보딩이 아직 완료되지 않았습니다.",
                "이 지침은 설치 단계가 아니라 Butler와 principal의 첫 만남을 위한 대화 지침입니다.", "",
                "대화 원칙:",
                "- 설치 마법사처럼 말하지 말고, 처음 만난 사람에게 자연스럽게 묻듯이 친근하고 차분하게 진행합니다.",
                "- 한 번에 하나의 질문만 합니다. 여러 질문을 한 메시지에 몰아서 묻지 않습니다.",
                "- 사용자가 불편해하거나 건너뛰겠다고 하면 존중하고 다음 항목으로 넘어갑니다.",
                "- 사용자의 실제 요청이 함께 있으면 요청을 무시하지 말고 짧게 응답한 뒤 자연스럽게 온보딩을 이어갑니다.",
                "- 사용자가 답한 필드는 `update_onboarding_profile` 도구로 저장합니다.",
                "- 페르소나 프리셋을 저장할 때는 목록의 persona_preset id 값을 그대로 도구의 `persona_preset`에 넣습니다. 프리뷰 문장을 `persona_custom`으로 흉내 내지 않습니다.",
                "- 마지막에는 선택된 페르소나를 적용하고 완료 상태를 저장합니다.", "",
                "권장 순서:", "1. 이름을 묻습니다.", "2. 어떻게 불러드리면 좋을지 묻습니다.",
                "3. 좋아하거나 관심 있는 것을 묻습니다. 건너뛰어도 된다고 말합니다.",
                "4. 직업이나 주 분야를 묻습니다. 건너뛰어도 된다고 말합니다.",
                "5. Butler를 뭐라고 부르면 좋을지 묻습니다.",
                "6. 어떻게 대해드리면 좋을지 묻고 아래 페르소나 프리셋 또는 직접 편집을 제안합니다.",
                "7. 장기 사용자 프로필 학습을 허용할지 묻습니다. 선택지는 `off`(사용 안 함), `basic`(명시 답변 중심), `deep`(대화에서 더 넓게 학습)이며, 사용자가 명시적으로 허용하지 않으면 `off`로 저장합니다.", "",
                "설정의 페르소나 프리셋 선택지:",
            ].into_iter().map(str::to_owned).collect(), options, vec![
                "- 직접 편집".into(), "".into(),
                if known.is_empty() { "이미 확인된 항목: 없음".into() }
                    else { format!("이미 확인된 항목: {}", known.join(", ")) },
                format!("다음 우선 질문: {next}"),
            ],
        ].concat().join("\n"))
    } else {
        Some([
            vec![
                "First-chat onboarding is still pending.",
                "This is not an installer or settings wizard. Treat it as Butler's first natural meeting with the principal.", "",
                "Conversation rules:", "- Ask like a friendly first meeting, not a form.",
                "- Ask only one question at a time.", "- Respect skip answers and move on.",
                "- If the principal also asks for a real task, answer briefly and then continue onboarding naturally.",
                "- Persist confirmed answers with the `update_onboarding_profile` tool.",
                "- When saving a persona preset, pass the listed persona_preset id to `persona_preset`. Do not imitate the preview text as `persona_custom`.",
                "- At the end, apply the selected persona and mark onboarding complete.", "",
                "Recommended order:", "1. Ask the principal's name.",
                "2. Ask how Butler should address the principal.",
                "3. Ask what the principal likes or is interested in, with permission to skip.",
                "4. Ask about work, profession, or main field, with permission to skip.",
                "5. Ask what Butler should be called.",
                "6. Ask how Butler should behave, offering persona presets or custom editing.",
                "7. Ask whether Butler may maintain a long-term user profile. Offer `off` (disabled), `basic` (explicit answers only), and `deep` (broader conversation learning). Store `off` unless the principal explicitly accepts profile learning.", "",
                "Settings persona preset options:",
            ].into_iter().map(str::to_owned).collect(), options, vec![
                "- Custom".into(), "".into(),
                if known.is_empty() { "Known fields: none".into() }
                    else { format!("Known fields: {}", known.join(", ")) },
                format!("Next priority question: {next}"),
            ],
        ].concat().join("\n"))
    }
}

fn missing(profile: &PersonalizationProfile, state: &FirstChatOnboardingState) -> Vec<String> {
    let skipped = &state.skipped_fields;
    [
        (
            profile.principal_name.is_empty(),
            "principal_name",
            "principal name",
        ),
        (
            profile.preferred_address.is_empty(),
            "preferred_address",
            "preferred address",
        ),
        (
            state.fields.interests.as_deref().unwrap_or("").is_empty(),
            "interests",
            "interests",
        ),
        (
            state.fields.work.as_deref().unwrap_or("").is_empty(),
            "work",
            "work or main field",
        ),
        (
            profile.butler_nickname.is_empty(),
            "butler_nickname",
            "Butler name",
        ),
        (
            state
                .fields
                .service_preference
                .as_deref()
                .unwrap_or("")
                .is_empty()
                && state.fields.persona_preset.is_none()
                && state.fields.persona_custom.is_none(),
            "service_preference",
            "desired Butler persona or treatment style",
        ),
        (
            state.fields.profiling_mode.is_none(),
            "profiling_mode",
            "profile learning consent",
        ),
    ]
    .into_iter()
    .filter(|(absent, key, _)| *absent && !skipped.iter().any(|v| v == key))
    .map(|(_, _, label)| label.into())
    .collect()
}
fn known(
    profile: &PersonalizationProfile,
    state: &FirstChatOnboardingState,
    locale: PersonaLocale,
) -> Vec<String> {
    let ko = locale == PersonaLocale::Ko;
    [
        (
            !profile.principal_name.is_empty(),
            if ko { "이름" } else { "name" },
        ),
        (
            !profile.preferred_address.is_empty(),
            if ko { "호칭" } else { "address" },
        ),
        (
            state.fields.interests.is_some(),
            if ko { "관심사" } else { "interests" },
        ),
        (
            state.fields.work.is_some(),
            if ko { "주 분야" } else { "work" },
        ),
        (
            !profile.butler_nickname.is_empty(),
            if ko { "Butler 이름" } else { "Butler name" },
        ),
        (
            state.fields.service_preference.is_some(),
            if ko {
                "대우 방식"
            } else {
                "treatment style"
            },
        ),
        (
            state.fields.persona_preset.is_some(),
            if ko { "페르소나" } else { "persona" },
        ),
        (
            state.fields.profiling_mode.is_some(),
            if ko {
                "프로파일링 동의"
            } else {
                "profile learning consent"
            },
        ),
    ]
    .into_iter()
    .filter(|(yes, _)| *yes)
    .map(|(_, name)| name.into())
    .collect()
}
