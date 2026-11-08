//! The copy of Settings > Personalization. Each field names its `packages/butler-i18n` key
//! (`settings.` prefix left out).
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// pageSections.profile
    pub(super) section_profile: &'static str,
    /// pageSections.responseStyle
    pub(super) section_response_style: &'static str,
    /// pageSections.learning
    pub(super) section_learning: &'static str,
    /// pageSectionDescriptions.learning
    pub(super) section_learning_description: &'static str,
    /// pageSections.agentImport
    pub(super) section_agent_import: &'static str,
    /// fields.butlerNickname, principalName, preferredAddress
    pub(super) profile_labels: [&'static str; 3],
    /// placeholders.butlerNickname, principalName, preferredAddress
    pub(super) profile_placeholders: [&'static str; 3],
    /// fields.responseLanguage
    pub(super) response_language: &'static str,
    /// descriptions.responseLanguage
    pub(super) response_language_description: &'static str,
    /// fields.personaPreset
    pub(super) persona_preset: &'static str,
    /// descriptions.personaPreset
    pub(super) persona_preset_description: &'static str,
    /// fields.persona
    pub(super) persona: &'static str,
    /// placeholders.persona
    pub(super) persona_placeholder: &'static str,
    /// fields.eol
    pub(super) eol: &'static str,
    /// placeholders.eol
    pub(super) eol_placeholder: &'static str,
    /// options.english
    pub(super) english: &'static str,
    /// options.korean
    pub(super) korean: &'static str,
    /// options.customPersona
    pub(super) custom_persona: &'static str,
    /// fields.profilingMode
    pub(super) profiling_mode: &'static str,
    /// descriptions.profilingMode
    pub(super) profiling_mode_description: &'static str,
    /// options.profilingOff, profilingBasic, profilingDeep
    pub(super) profiling_labels: [&'static str; 3],
    /// descriptions.profilingOff, profilingBasic, profilingDeep
    pub(super) profiling_descriptions: [&'static str; 3],
    /// fields.profilingExtractorModel
    pub(super) extractor_model: &'static str,
    /// descriptions.profilingExtractorModel
    pub(super) extractor_model_description: &'static str,
    /// options.profilingExtractorDefault
    pub(super) extractor_default: &'static str,
    /// descriptions.profilingExtractorDefault
    pub(super) extractor_default_description: &'static str,
    /// fields.reasoning
    pub(super) reasoning: &'static str,
    /// memory.linkLabel
    pub(super) memory_link: &'static str,
    /// memory.linkDescription
    pub(super) memory_link_description: &'static str,
    /// memory.linkOpen
    pub(super) memory_link_open: &'static str,
    /// actions.applyPersonalization
    pub(super) apply: &'static str,
    /// fields.profileMigrationImport
    pub(super) migration_title: &'static str,
    /// descriptions.profileMigration
    pub(super) migration_description: &'static str,
    /// fields.profileMigrationPrompt
    pub(super) migration_prompt: &'static str,
    /// fields.profileMigrationDump
    pub(super) migration_dump: &'static str,
    /// placeholders.profileMigrationDump
    pub(super) migration_dump_placeholder: &'static str,
    /// actions.openProfileMigration
    pub(super) migration_open: &'static str,
    /// actions.closeProfileMigration
    pub(super) migration_close: &'static str,
    /// actions.copyMigrationPrompt
    pub(super) migration_copy: &'static str,
    /// actions.importProfileMigration
    pub(super) migration_import: &'static str,
    /// actions.importProfileMigrationRunning
    pub(super) migration_running: &'static str,
    /// descriptions.profileMigrationImporting
    pub(super) migration_importing: &'static str,
    /// descriptions.profileMigrationStored
    pub(super) migration_stored: &'static str,
    /// descriptions.profileMigrationNoNewInfo
    pub(super) migration_no_new_info: &'static str,
    /// errors.profileMigration
    pub(super) err_migration: &'static str,
    /// errors.profileMigrationProfilingOff
    pub(super) err_migration_profiling_off: &'static str,
    /// errors.loadPersonalization
    pub(super) err_load: &'static str,
    /// errors.updatePersonalization
    pub(super) err_update: &'static str,
    /// agentImport.purpose
    pub(super) import_purpose: &'static str,
    /// agentImport.run
    pub(super) import_run: &'static str,
    /// agentImport.importing
    pub(super) import_importing: &'static str,
    /// agentImport.nothingNew
    pub(super) import_nothing_new: &'static str,
    /// agentImport.more
    pub(super) import_more: &'static str,
    /// agentImport.noSources
    pub(super) import_no_sources: &'static str,
    /// agentImport.failed
    pub(super) import_failed: &'static str,
    /// agentImport.retry
    pub(super) import_retry: &'static str,
}

const KO: Words = Words {
    section_profile: "프로필",
    section_response_style: "응답 스타일",
    section_learning: "알아가기",
    section_learning_description: "버틀러가 대화하면서 사용자를 알아가는 범위입니다.",
    section_agent_import: "다른 AI에서 가져오기",
    profile_labels: ["버틀러 닉네임", "내 이름", "나를 부를 호칭"],
    profile_placeholders: [
        "예: 버틀러, 알프레드",
        "예: 사용할 이름",
        "예: 선생님, 대표님",
    ],
    response_language: "답변 언어",
    response_language_description: "버틀러가 채팅에서 최종 답변과 진행 상태를 말할 때 사용할 언어입니다.",
    persona_preset: "페르소나 프리셋",
    persona_preset_description: "프리셋을 고르면 아래 페르소나 초안만 바뀌고, 적용 전에는 저장되지 않습니다.",
    persona: "페르소나",
    persona_placeholder: "버틀러가 자신을 표현하고 사용자와 협업하는 방식",
    eol: "얼",
    eol_placeholder: "장기 선호, 경계, 오래 유지할 운영 메모",
    english: "영어",
    korean: "한국어",
    custom_persona: "직접 편집",
    profiling_mode: "범위",
    profiling_mode_description: "동의하면 로컬 대화에서 맞춤 응답에 필요한 정보를 저장하고 활용합니다.",
    profiling_labels: ["끄기", "기본", "깊게"],
    profiling_descriptions: [
        "사용자를 알아가지 않습니다. 기능상 필요한 현재 설정만 사용합니다.",
        "말투, 설명 방식, 작업 방식 선호를 맞춤 응답에 사용합니다.",
        "최근 관심사, 의미 있는 맥락, 가치 판단까지 맞춤 응답에 사용합니다.",
    ],
    extractor_model: "알아가기 모델",
    extractor_model_description: "개인화에 필요한 정보를 읽어낼 때 사용할 모델입니다.",
    extractor_default: "모델 기본값",
    extractor_default_description: "현재 버틀러 기본 모델 설정을 그대로 따릅니다.",
    reasoning: "추론",
    memory_link: "기억",
    memory_link_description: "기억한 내용을 보고 관리합니다.",
    memory_link_open: "열기",
    apply: "적용",
    migration_title: "기억 가져오기",
    migration_description: "다른 AI 서비스의 기억을 옮겨요",
    migration_prompt: "가져오기 프롬프트",
    migration_dump: "가져온 프로필 내용",
    migration_dump_placeholder: "다른 AI가 돌려준 JSON 또는 요약 내용을 붙여넣으세요.",
    migration_open: "가져오기",
    migration_close: "닫기",
    migration_copy: "프롬프트 복사",
    migration_import: "프로필 가져오기",
    migration_running: "가져오는 중",
    migration_importing: "가져온 기억을 읽고 프로필에 반영하는 중입니다.",
    migration_stored: "가져온 내용은 저장되었습니다. 다음 답변에 사용할 만큼 확실한 정보가 생기면 반영됩니다.",
    migration_no_new_info: "가져오기는 끝났지만 새로 반영할 정보는 찾지 못했습니다.",
    err_migration: "프로필 가져오기 실패",
    err_migration_profiling_off: "알아가기가 꺼져 있어 가져온 내용을 반영하지 않았습니다.",
    err_load: "개인화 불러오기 실패",
    err_update: "개인화 업데이트 실패",
    import_purpose: "지침과 MCP 서버를 버틀러로 옮겨요",
    import_run: "가져오기",
    import_importing: "가져오는 중…",
    import_nothing_new: "새로 추가할 항목이 없어요",
    import_more: "더 가져오기",
    import_no_sources: "찾은 AI 도구가 없어요",
    import_failed: "가져오지 못했어요",
    import_retry: "다시 시도",
};

const EN: Words = Words {
    section_profile: "Profile",
    section_response_style: "Response style",
    section_learning: "Profile building",
    section_learning_description: "How much Butler picks up about you from your chats.",
    section_agent_import: "Import from other AI tools",
    profile_labels: ["Butler nickname", "My name", "Preferred address"],
    profile_placeholders: [
        "Example: Butler, Alfred",
        "Example: your preferred name",
        "Example: boss, captain",
    ],
    response_language: "Response language",
    response_language_description: "The language Butler uses for final chat replies and progress updates.",
    persona_preset: "Persona preset",
    persona_preset_description: "Choosing a preset only changes the persona draft below. Nothing is saved until you apply it.",
    persona: "Persona",
    persona_placeholder: "How Butler expresses itself and collaborates with you",
    eol: "EOL",
    eol_placeholder: "Long-term preferences, boundaries, and durable operating notes",
    english: "English",
    korean: "Korean",
    custom_persona: "Custom",
    profiling_mode: "Level",
    profiling_mode_description: "With consent, Butler stores and uses information from local conversations for personalized replies.",
    profiling_labels: ["Off", "Basic", "Deep"],
    profiling_descriptions: [
        "Butler doesn't build a profile. It uses only the settings it needs to work.",
        "Use tone, explanation style, and workflow preferences for personalized replies.",
        "Use recent interests, meaningful context, and values for personalized replies.",
    ],
    extractor_model: "Profile-building model",
    extractor_model_description: "The model used to extract information needed for personalization.",
    extractor_default: "Model default",
    extractor_default_description: "Use the current Butler default model setting.",
    reasoning: "Reasoning",
    memory_link: "Memory",
    memory_link_description: "See what Butler remembers and remove what you don't want.",
    memory_link_open: "Manage",
    apply: "Apply",
    migration_title: "Import memory",
    migration_description: "Bring memory from another AI service",
    migration_prompt: "Import prompt",
    migration_dump: "Imported profile content",
    migration_dump_placeholder: "Paste JSON or a summary returned by another AI.",
    migration_open: "Import",
    migration_close: "Close",
    migration_copy: "Copy prompt",
    migration_import: "Import profile",
    migration_running: "Importing",
    migration_importing: "Reading imported memories and applying them to the profile.",
    migration_stored: "The import was stored. Butler will apply it once there is enough reliable information for future replies.",
    migration_no_new_info: "Import finished, but no new profile information was found.",
    err_migration: "Failed to import profile",
    err_migration_profiling_off: "Profile building is off, so the import wasn't applied.",
    err_load: "Failed to load personalization",
    err_update: "Failed to update personalization",
    import_purpose: "Bring instructions and MCP servers into Butler",
    import_run: "Import",
    import_importing: "Importing…",
    import_nothing_new: "Nothing new to add",
    import_more: "Import more",
    import_no_sources: "No AI tools found",
    import_failed: "Couldn't import",
    import_retry: "Retry",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// descriptions.profileMigrationApplied
pub(super) fn migration_applied(lang: Lang, count: u64) -> String {
    match lang {
        Lang::Ko => format!(
            "가져오기가 완료되었습니다. {count}개 정보를 프로필에 반영했고, 다음 답변부터 사용됩니다."
        ),
        Lang::En => format!(
            "Import complete. {count} items were applied to the profile and will be used in future replies."
        ),
    }
}

/// descriptions.eolLastLoaded
pub(super) fn eol_last_loaded(lang: Lang, value: &str) -> String {
    match lang {
        Lang::Ko => format!("마지막으로 불러온 시각 {value}"),
        Lang::En => format!("Last loaded at {value}"),
    }
}

/// agentImport.found
pub(super) fn import_found(lang: Lang, instructions: bool, servers: u64) -> String {
    let parts: Vec<String> = [
        instructions.then(|| match lang {
            Lang::Ko => "지침".to_owned(),
            Lang::En => "Instructions".to_owned(),
        }),
        (servers > 0).then(|| match lang {
            Lang::Ko => format!("MCP 서버 {servers}개"),
            Lang::En => format!(
                "{servers} MCP server{}",
                if servers == 1 { "" } else { "s" }
            ),
        }),
    ]
    .into_iter()
    .flatten()
    .collect();
    if parts.is_empty() {
        match lang {
            Lang::Ko => "가져올 설정 없음".to_owned(),
            Lang::En => "Nothing to import".to_owned(),
        }
    } else {
        parts.join(" · ")
    }
}

/// agentImport.result
pub(super) fn import_result(
    lang: Lang,
    instructions: u64,
    servers: u64,
    needs_secret: u64,
) -> String {
    match lang {
        Lang::Ko => {
            let key = if needs_secret > 0 {
                format!(" · 키 입력 필요 {needs_secret}개 — 설정 › MCP")
            } else {
                String::new()
            };
            format!("지침 {instructions}개 · MCP 서버 {servers}개 추가{key}")
        }
        Lang::En => {
            let key = if needs_secret > 0 {
                let verb = if needs_secret == 1 { "needs" } else { "need" };
                format!(" · {needs_secret} {verb} a key — Settings › MCP")
            } else {
                String::new()
            };
            let s = |n: u64| if n == 1 { "" } else { "s" };
            format!(
                "Added {instructions} instruction{} · {servers} MCP server{}{key}",
                s(instructions),
                s(servers)
            )
        }
    }
}
